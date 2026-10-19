"""Aggregate validated per-video analyses from every session into a growing dataset (JSONL)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import load_config
from .sessions import session_dirs
from .util import read_json
from .validate import validate_video


def export(sessions_dir: Path, out: Path) -> dict:
    out.parent.mkdir(parents=True, exist_ok=True)
    n_obs = n_vid = 0
    skipped = 0
    with open(out, "w", encoding="utf-8") as fh:
        for s in session_dirs(sessions_dir):
            meta = {e["id"]: e for e in (read_json(s / "metadata.json", {}) or {}).get("videos", []) if e.get("file")}
            by_file = {Path(e["file"]).stem: e for e in meta.values()}
            vd = s / "analysis" / "videos"
            for f in sorted(vd.glob("*.json")) if vd.is_dir() else []:
                if validate_video(f, s / "analysis" / "prep"):
                    skipped += 1
                    continue
                d = read_json(f)
                src = by_file.get(f.stem, {})
                n_vid += 1
                ref = {"session": s.name, "video": f.stem, "url": src.get("url"), "creator": src.get("creator"),
                       "sha256": src.get("sha256")}
                for kind in ("observations", "inferences"):
                    for item in d[kind]:
                        rec = "observation" if kind == "observations" else "inference"
                        fh.write(json.dumps({"record": rec, "source": ref, **item}, ensure_ascii=False) + "\n")
                        n_obs += 1
    return {"videos": n_vid, "records": n_obs, "skipped_invalid": skipped, "file": str(out)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m vie.export")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    cfg = load_config()
    out = Path(a.out) if a.out else cfg.root / "dataset" / "observations.jsonl"
    print(json.dumps(export(cfg.sessions_dir, out)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
