"""Downloading via yt-dlp using the user's own logged-in session cookies.

Only supported, normal access is used: no CAPTCHA/DRM/paywall bypass. When a reel cannot be fetched
(private, removed, login wall, DRM) the result is 'unavailable' and the caller records the URL only.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .util import LOG, video_summary, ffprobe

# stderr fragments -> permanent (not worth retrying) outcomes
UNAVAILABLE_HINTS = (
    "login required", "private", "not available", "unavailable", "has been removed", "no video formats",
    "requested content is not available", "drm", "restricted video", "age-restricted", "no video could be found",
    "unsupported url", "does not exist",
)
TRANSIENT_HINTS = ("rate-limit", "rate limit", "429", "too many requests", "timed out", "temporary", "connection",
                   "http error 5", "unable to download", "read error")


@dataclass
class DownloadResult:
    ok: bool
    file: Path | None = None
    info: dict = field(default_factory=dict)
    error: str = ""
    kind: str = ""  # "" | "unavailable" | "transient" | "failed"


def write_cookies_file(cookies: list[dict], path: Path) -> None:
    """Netscape cookie file (what yt-dlp expects), mode 0600, kept outside the repo."""
    lines = ["# Netscape HTTP Cookie File"]
    for c in cookies:
        dom = c["domain"]
        sub = "TRUE" if dom.startswith(".") else "FALSE"
        exp = int(c["expires"]) if c.get("expires", -1) and c["expires"] > 0 else 0
        pre = "#HttpOnly_" if c.get("httpOnly") else ""
        lines.append("\t".join([pre + dom, sub, c.get("path", "/"), "TRUE" if c.get("secure") else "FALSE",
                                str(exp), c["name"], c["value"]]))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, path)  # atomic: a running yt-dlp never sees a half-written file


def classify(stderr: str) -> str:
    low = stderr.lower()
    if any(h in low for h in TRANSIENT_HINTS) and "not available" not in low:
        return "transient"
    if any(h in low for h in UNAVAILABLE_HINTS):
        return "unavailable"
    return "failed"


def trim_info(info: dict) -> dict:
    keys = ("id", "title", "description", "uploader", "uploader_id", "channel", "timestamp", "upload_date",
            "duration", "width", "height", "fps", "vcodec", "acodec", "ext", "format_id", "like_count",
            "view_count", "comment_count", "webpage_url")
    return {k: info[k] for k in keys if info.get(k) is not None}


NICE = 10  # set from config by the collector


def ytdlp_download(url: str, workdir: Path, cookies: Path | None, fmt: str, timeout: int,
                   abort: threading.Event | None = None) -> DownloadResult:
    """Download `url` into `workdir` (a private scratch dir). Never raises for expected failures."""
    workdir.mkdir(parents=True, exist_ok=True)
    tag = uuid.uuid4().hex[:8]
    cmd = [sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-progress", "--no-warnings", "--no-colors",
           "-f", fmt, "--merge-output-format", "mp4", "--write-info-json", "--no-mtime",
           "-o", str(workdir / f"{tag}.%(ext)s"), "--print", "after_move:filepath"]
    if cookies and cookies.is_file():
        cmd += ["--cookies", str(cookies)]
    cmd.append(url)
    LOG.debug("yt-dlp: %s", " ".join(cmd[:3] + ["..."] + cmd[-1:]))
    # own session: terminal Ctrl+C is delivered to us, and we decide whether to wait or abort
    if NICE and shutil.which("nice"):  # polite to the desktop (not preexec_fn: unsafe with our worker threads)
        cmd = ["nice", "-n", str(NICE)] + cmd
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    out_err: list[tuple[str, str]] = []
    t = threading.Thread(target=lambda: out_err.append(proc.communicate()), daemon=True)
    t.start()
    waited = 0.0
    while t.is_alive():
        t.join(0.25)
        waited += 0.25
        if abort is not None and abort.is_set():
            _kill(proc)
            t.join(5)
            return DownloadResult(False, error="aborted by user", kind="aborted")
        if waited > timeout:
            _kill(proc)
            t.join(5)
            return DownloadResult(False, error=f"download timed out after {timeout}s", kind="transient")
    stdout, stderr = out_err[0] if out_err else ("", "")
    if proc.returncode != 0:
        msg = (stderr.strip().splitlines() or ["yt-dlp failed"])[-1][:400]
        return DownloadResult(False, error=msg, kind=classify(stderr))
    files = [Path(p) for p in stdout.strip().splitlines() if p.strip() and Path(p).is_file()]
    if not files:
        return DownloadResult(False, error="yt-dlp produced no file", kind="failed")
    media = files[-1]
    info = {}
    ij = workdir / f"{tag}.info.json"
    if ij.is_file():
        try:
            info = trim_info(json.loads(ij.read_text(encoding="utf-8")))
        finally:
            ij.unlink(missing_ok=True)
    try:
        info["probe"] = video_summary(ffprobe(media))
        if info["probe"]["duration_s"] <= 0:
            raise RuntimeError("zero duration")
    except Exception as e:  # corrupt/truncated download: scratch file, safe to discard
        media.unlink(missing_ok=True)
        return DownloadResult(False, error=f"downloaded file failed verification: {e}", kind="transient")
    return DownloadResult(True, file=media, info=info)


def _kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(3)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)


def clean_dir(d: Path) -> None:
    shutil.rmtree(d, ignore_errors=True)
