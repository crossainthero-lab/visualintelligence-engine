"""Scroll Sessions: one immutable folder per collector run.

scroll-sessions/<YYYY-MM-DD_HHMM>/{videos/, metadata.json, session.json, analysis/}
"""
from __future__ import annotations

import os
import re
import socket
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from .util import LOG, read_json, write_json

SCHEMA = 1
SESSION_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{4}(_\d{2})?$")
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


class Session:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.videos_dir = self.path / "videos"
        self.analysis_dir = self.path / "analysis"
        self.partial_dir = self.videos_dir / ".partial"
        self._lock = threading.RLock()
        self.meta = read_json(self.path / "metadata.json", {"schema": SCHEMA, "session": self.path.name, "videos": []})
        self.info = read_json(self.path / "session.json", {})

    @property
    def id(self) -> str:
        return self.path.name

    # ---- creation -------------------------------------------------------------------------
    @classmethod
    def create(cls, sessions_dir: Path, config_snapshot: dict | None = None, now: datetime | None = None) -> "Session":
        """Create a brand-new session folder. Never reuses or touches an existing one."""
        sessions_dir = Path(sessions_dir)
        sessions_dir.mkdir(parents=True, exist_ok=True)
        now = now or datetime.now()
        base = now.strftime("%Y-%m-%d_%H%M")
        for n in range(1, 100):
            name = base if n == 1 else f"{base}_{n:02d}"
            try:
                (sessions_dir / name).mkdir()  # exist_ok=False -> atomic claim
                break
            except FileExistsError:
                continue
        else:
            raise RuntimeError("could not allocate a session folder")
        s = cls(sessions_dir / name)
        s.videos_dir.mkdir()
        s.analysis_dir.mkdir()
        s.info = {
            "schema": SCHEMA, "id": name, "status": "running", "started_at": now_iso(), "ended_at": None,
            "host": socket.gethostname(), "pid": os.getpid(), "python": sys.version.split()[0],
            "counts": {}, "stop_reason": None, "config": config_snapshot or {},
        }
        s.meta = {"schema": SCHEMA, "session": name, "videos": []}
        s.save()
        return s

    # ---- persistence ------------------------------------------------------------------------
    def save(self) -> None:
        with self._lock:
            self.info["counts"] = self.counts()
            write_json(self.path / "metadata.json", self.meta)
            write_json(self.path / "session.json", self.info)

    def finish(self, status: str, reason: str) -> None:
        self.info.update(status=status, ended_at=now_iso(), stop_reason=reason)
        self.save()

    # ---- entries ---------------------------------------------------------------------------
    @property
    def entries(self) -> list[dict]:
        return self.meta["videos"]

    def get(self, code: str) -> dict | None:
        return next((e for e in self.entries if e["id"] == code), None)

    def add(self, entry: dict) -> dict:
        entry.setdefault("status", "discovered")
        entry.setdefault("discovered_at", now_iso())
        entry.setdefault("attempts", 0)
        with self._lock:
            self.entries.append(entry)
            self.save()
        return entry

    def update(self, entry: dict, **fields) -> None:
        with self._lock:  # workers mutate entries while another thread serialises them
            entry.update(fields)
            self.save()

    def counts(self) -> dict:
        c: dict[str, int] = {}
        for e in self.entries:
            c[e["status"]] = c.get(e["status"], 0) + 1
        c["total"] = len(self.entries)
        return c

    # ---- video files (never overwritten, never deleted) -------------------------------------
    def ingest(self, tmp_file: Path) -> Path:
        """Move a finished download into videos/NNNN.ext without ever replacing an existing file."""
        ext = tmp_file.suffix.lower() or ".mp4"
        self.videos_dir.mkdir(exist_ok=True)
        with self._lock:
            used = [int(p.stem) for p in self.videos_dir.iterdir() if p.stem.isdigit()]
            n = max(used, default=0) + 1
            while True:
                dest = self.videos_dir / f"{n:04d}{ext}"
                try:
                    os.link(tmp_file, dest)  # fails if dest exists -> cannot overwrite
                    break
                except FileExistsError:
                    n += 1
        os.unlink(tmp_file)
        os.chmod(dest, 0o444)  # originals are read-only
        return dest


# ---- cross-session helpers -----------------------------------------------------------------
def session_dirs(sessions_dir: Path) -> list[Path]:
    sessions_dir = Path(sessions_dir)
    if not sessions_dir.is_dir():
        return []
    return sorted(p for p in sessions_dir.iterdir() if p.is_dir() and SESSION_RE.match(p.name))


def known_videos(sessions_dir: Path) -> dict[str, dict]:
    """shortcode -> {status, session, file} for everything already downloaded in any session."""
    known: dict[str, dict] = {}
    for d in session_dirs(sessions_dir):
        meta = read_json(d / "metadata.json", {}) or {}
        for e in meta.get("videos", []):
            if e.get("status") == "downloaded" and e.get("file"):
                known.setdefault(e["id"], {"session": d.name, "file": e["file"]})
    return known


def list_video_files(session_path: Path) -> list[Path]:
    vd = Path(session_path) / "videos"
    if not vd.is_dir():
        return []
    return sorted(p for p in vd.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXTS and not p.name.startswith("."))


def pid_is_collector(pid: int | None) -> bool:
    """True only if `pid` is a live process that is one of OUR collectors (pid reuse after a reboot is common)."""
    if not pid or pid <= 0:
        return False
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmd = f.read().decode(errors="replace")
    except OSError:
        return False
    return "vie.collect_cli" in cmd or "collect_cli" in cmd


def recover_stale_sessions(sessions_dir: Path, skip: str | None = None) -> list[str]:
    """Sessions still marked 'running' whose collector is gone (crash, kill, power loss, desktop freeze) become
    'interrupted'; anything half-way ('downloading') goes back to 'queued' so `--resume` can finish it. Only
    status fields change; no media or metadata is deleted. Call while holding the collector instance lock."""
    fixed = []
    for d in session_dirs(sessions_dir):
        if d.name == skip:
            continue
        info = read_json(d / "session.json", None)
        if not info or info.get("status") != "running" or pid_is_collector(info.get("pid")):
            continue
        meta = read_json(d / "metadata.json", {"videos": []}) or {"videos": []}
        for e in meta.get("videos", []):
            if e.get("status") in ("downloading",):
                e["status"] = "queued"
        info.update(status="interrupted", ended_at=info.get("ended_at") or now_iso(),
                    stop_reason=info.get("stop_reason") or "recovered: collector process died (crash, kill or freeze)",
                    recovered=True)
        write_json(d / "metadata.json", meta)
        write_json(d / "session.json", info)
        fixed.append(d.name)
    return fixed
