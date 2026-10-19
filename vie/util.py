"""Small shared helpers: atomic JSON, logging, subprocess probing."""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

LOG = logging.getLogger("vie")
_SECRETS: set[str] = set()


def register_secret(value: str) -> None:
    """Anything registered here is replaced with *** in every log line."""
    if value and len(value) >= 8:
        _SECRETS.add(value)


class _Redact(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if _SECRETS:
            msg = record.getMessage()
            for s in _SECRETS:
                msg = msg.replace(s, "***")
            record.msg, record.args = msg, ()
        return True


def setup_logging(logfile: Path | None = None, verbose: bool = False) -> None:
    LOG.setLevel(logging.DEBUG)
    LOG.handlers.clear()
    LOG.filters.clear()
    LOG.addFilter(_Redact())
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%H:%M:%S")
    sh = logging.StreamHandler(sys.stderr)
    sh.setLevel(logging.DEBUG if verbose else logging.INFO)
    sh.setFormatter(fmt)
    LOG.addHandler(sh)
    if logfile:
        fh = logging.FileHandler(logfile, encoding="utf-8")
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
        LOG.addHandler(fh)


def write_json(path: Path, data, mode: int | None = None) -> None:
    """Atomic write: a crash/Ctrl+C can never leave a half-written file."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, sort_keys=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def read_json(path: Path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def need(binary: str) -> str:
    p = shutil.which(binary)
    if not p:
        raise RuntimeError(f"{binary} not found on PATH (sudo apt install ffmpeg)")
    return p


def ffprobe(path: Path) -> dict:
    """Return ffprobe JSON, raising RuntimeError if the file is not a decodable media file."""
    r = subprocess.run(
        [need("ffprobe"), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {path.name}: {r.stderr.strip()[:300]}")
    return json.loads(r.stdout)


def video_summary(probe: dict) -> dict:
    v = next((s for s in probe.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in probe.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not v:
        raise RuntimeError("no video stream")
    num, _, den = (v.get("avg_frame_rate") or "0/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    dur = float(probe.get("format", {}).get("duration") or v.get("duration") or 0)
    return {
        "duration_s": round(dur, 3), "width": v.get("width"), "height": v.get("height"),
        "fps": round(fps, 3), "video_codec": v.get("codec_name"), "pix_fmt": v.get("pix_fmt"),
        "color_space": v.get("color_space"), "color_transfer": v.get("color_transfer"),
        "has_audio": a is not None, "audio_codec": a.get("codec_name") if a else None,
        "audio_channels": a.get("channels") if a else None,
        "audio_sample_rate": int(a["sample_rate"]) if a and a.get("sample_rate") else None,
        "bit_rate": int(probe["format"]["bit_rate"]) if probe.get("format", {}).get("bit_rate") else None,
    }
