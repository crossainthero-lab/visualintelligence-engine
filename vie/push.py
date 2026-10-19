"""Push finished Scroll Sessions to a Visual Intelligence server (remote-collector mode). No third-party account needed:
pair once with `visualintelligence collectors pair <name>` on the server, then set VIE_SERVER + VIE_COLLECTOR_TOKEN
(or put the token in ~/.config/visualintelligence/collector.token, mode 0600).

Safe to re-run at any time: files are content-addressed (sha256), uploads resume from the server's byte offset, and the
server verifies every file before it becomes visible. Unchanged files are never sent twice. Videos stay on this machine
unless `--files` is given (metadata-only sync = 'desktop storage with remote metadata').
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from .config import load_config
from .sessions import session_dirs
from .util import read_json

CHUNK = 4 * 1024 * 1024


class Client:
    def __init__(self, base: str, token: str):
        self.base, self.token = base.rstrip("/"), token

    def req(self, path, method="GET", data=None, headers=None, raw=False):
        h = {"Authorization": f"Bearer {self.token}", **(headers or {})}
        if data is not None and not raw:
            data, h["content-type"] = json.dumps(data).encode(), "application/json"
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=120) as resp:
                body = resp.read()
                return resp.status, dict(resp.headers), (json.loads(body) if body and not raw and resp.headers.get("content-type", "").startswith("application/json") else body)
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                return e.code, dict(e.headers), json.loads(body)
            except ValueError:
                return e.code, dict(e.headers), body


def token() -> str:
    t = os.environ.get("VIE_COLLECTOR_TOKEN", "").strip()
    if t:
        return t
    p = Path("~/.config/visualintelligence/collector.token").expanduser()
    if p.is_file():
        if p.stat().st_mode & 0o077:
            raise SystemExit(f"{p} must not be readable by others (chmod 600)")
        return p.read_text().strip()
    raise SystemExit("no collector token: set VIE_COLLECTOR_TOKEN or ~/.config/visualintelligence/collector.token")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def upload(cl: Client, sha: str, path: Path) -> str:
    size = path.stat().st_size
    st, hd, _ = cl.req(f"/api/ingest/blob/{sha}", "HEAD")
    hd = {k.lower(): v for k, v in hd.items()}
    if hd.get("x-complete") == "1":
        return "exists"
    off = int(hd.get("x-received", 0))
    with open(path, "rb") as f:
        f.seek(off)
        while True:
            chunk = f.read(CHUNK)
            last = f.tell() >= size
            headers = {"x-offset": str(off), **({"x-final-size": str(size)} if last else {})}
            st, _, body = cl.req(f"/api/ingest/blob/{sha}", "PUT", chunk, headers, raw=True)
            if st == 409 and isinstance(body, dict):  # server has a different offset: resume from it
                off = body.get("received", 0)
                f.seek(off)
                continue
            if st != 200:
                raise RuntimeError(f"upload failed: HTTP {st} {body[:200]!r}")
            off += len(chunk)
            if last:
                return "uploaded"


def push_session(cl: Client, sdir: Path, files: bool, log=print) -> dict:
    info, meta = read_json(sdir / "session.json", {}), read_json(sdir / "metadata.json", {"videos": []})
    entries = meta.get("videos", [])
    slim = {k: info.get(k) for k in ("started_at", "ended_at", "status", "mode", "source", "stop_reason", "host", "saved_collections", "creators_browsed", "recovered", "instagram_account")}
    slim["id"] = sdir.name
    stats = {"uploaded": 0, "exists": 0, "skipped": 0}
    if files:
        todo = []
        for e in entries:
            fp = sdir / e["file"] if e.get("status") == "downloaded" and e.get("file") else None
            if not fp or not fp.is_file() or fp.stat().st_size == 0:
                if fp:
                    e["status"] = "failed"; e["error"] = "file empty or missing on collector"; e["file"] = None
                continue
            e["sha256"] = e.get("sha256") or sha256(fp)
            todo.append((e["sha256"], fp))
        st, _, have = cl.req("/api/ingest/have", "POST", {"shas": [s for s, _ in todo]})
        missing = set(have["missing"])
        for s, fp in todo:
            if s in missing:
                stats[upload(cl, s, fp)] += 1
                log(f"  uploaded {fp.name} ({fp.stat().st_size/1e6:.1f} MB)")
            else:
                stats["exists"] += 1
    st, _, res = cl.req("/api/ingest/session", "POST", {"session": slim, "videos": entries, "metadataOnly": not files})
    if st != 200:
        raise RuntimeError(f"server rejected session {sdir.name}: HTTP {st} {res}")
    return {**stats, **res}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m vie.push", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sessions", nargs="*", help="session ids (default: all not yet pushed)")
    ap.add_argument("--server", default=os.environ.get("VIE_SERVER"), help="e.g. http://192.168.1.50:3100")
    ap.add_argument("--files", action="store_true", help="also upload the video files (centralised storage); default is metadata only")
    ap.add_argument("--check", action="store_true", help="only test the connection and token")
    a = ap.parse_args(argv)
    if not a.server:
        raise SystemExit("--server or VIE_SERVER required")
    cl = Client(a.server, token())
    st, _, body = cl.req("/api/ingest/ping")
    if st != 200:
        print(f"server refused the connection: HTTP {st} {body}", file=sys.stderr)
        return 1
    print(f"connected to {a.server} as collector {body.get('collector')}")
    if a.check:
        return 0
    cfg = load_config()
    dirs = [d for d in session_dirs(cfg.sessions_dir) if not a.sessions or d.name in a.sessions]
    state_f = cfg.state_dir / "pushed.json"
    pushed = read_json(state_f, {})
    rc = 0
    for d in dirs:
        stamp = f"{(d / 'metadata.json').stat().st_mtime_ns}:{a.files}"
        if not a.sessions and pushed.get(d.name) == stamp:
            continue
        try:
            r = push_session(cl, d, a.files)
            print(f"{d.name}: {r['entries']} entries, {r.get('uploaded', 0)} uploaded, {r.get('exists', 0)} already on server")
            pushed[d.name] = stamp
        except Exception as e:  # noqa: BLE001
            print(f"{d.name}: FAILED {e}", file=sys.stderr)
            rc = 1
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    from .util import write_json
    write_json(state_f, pushed, 0o600)
    return rc


if __name__ == "__main__":
    sys.exit(main())
