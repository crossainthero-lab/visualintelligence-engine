"""Validates analysis outputs and computes honest analysis status from the files on disk.

The point: an observation must cite frames/measurements that really exist, so a model cannot claim to
have 'watched' a video it only read metadata about.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .sessions import list_video_files
from .util import read_json, write_json

CATEGORIES = {"motion_graphics", "animation_2d", "animation_3d", "compositing", "editing_rhythm", "transitions",
              "typography", "easing", "camera", "composition", "lighting", "colour", "materials", "depth", "music",
              "sound_design", "audio_sync", "storytelling", "advertising", "aesthetic", "other"}
CONF = {"high", "medium", "low"}
AUDIO_EVIDENCE = {"none", "measured-only", "spectrogram", "transcript"}
MIN_FRAMES_VIEWED = 5


def validate_video(vid_json: Path, prep_dir: Path) -> list[str]:
    errs: list[str] = []
    d = read_json(vid_json)
    if not isinstance(d, dict):
        return ["not valid JSON"]
    vid = vid_json.stem
    facts = read_json(prep_dir / vid / "facts.json")
    if not facts:
        return [f"no prep/{vid}/facts.json (run: python -m vie.prep session <dir>)"]
    dur = facts["probe"]["duration_s"]
    frames_ok = {f["file"] for f in facts["frames"]}
    for k in ("video", "summary", "evidence_reviewed", "observations", "inferences", "uncertainties", "recreation"):
        if k not in d:
            errs.append(f"missing key '{k}'")
    if errs:
        return errs
    if d["video"] != vid:
        errs.append(f"video id '{d['video']}' != file name '{vid}'")
    ev = d["evidence_reviewed"]
    viewed = ev.get("frames", [])
    bad = [f for f in viewed if f not in frames_ok]
    if bad:
        errs.append(f"evidence_reviewed.frames lists files that do not exist: {bad[:3]}")
    need = min(MIN_FRAMES_VIEWED, len(frames_ok))
    if len(set(viewed) - set(bad)) < need:
        errs.append(f"must have viewed at least {need} real frames (listed {len(viewed)})")
    if ev.get("audio") not in AUDIO_EVIDENCE:
        errs.append(f"evidence_reviewed.audio must be one of {sorted(AUDIO_EVIDENCE)}")
    if ev.get("measured_facts") is not True:
        errs.append("evidence_reviewed.measured_facts must be true (read facts.json)")
    ids = set()
    for o in d["observations"]:
        oid = o.get("id", "?")
        ids.add(oid)
        if o.get("category") not in CATEGORIES:
            errs.append(f"observation {oid}: bad category {o.get('category')!r}")
        if o.get("confidence") not in CONF:
            errs.append(f"observation {oid}: bad confidence")
        if not o.get("text"):
            errs.append(f"observation {oid}: empty text")
        t0, t1 = o.get("t_start"), o.get("t_end")
        if not isinstance(t0, (int, float)) or not isinstance(t1, (int, float)) or not (0 <= t0 <= t1 <= dur + 0.5):
            errs.append(f"observation {oid}: t_start/t_end must be numbers within 0..{dur}")
        cited = o.get("evidence_frames", [])
        if any(f not in frames_ok for f in cited):
            errs.append(f"observation {oid}: cites non-existent frames")
        if not cited and not o.get("evidence_measured"):
            errs.append(f"observation {oid}: needs evidence_frames or evidence_measured (e.g. 'rhythm.average_shot_length_s')")
        if o.get("category") in ("music", "sound_design", "audio_sync") and ev.get("audio") in ("none",) and not o.get("evidence_measured"):
            errs.append(f"observation {oid}: audio claim without audio evidence")
    for i in d["inferences"]:
        iid = i.get("id", "?")
        if i.get("confidence") not in CONF:
            errs.append(f"inference {iid}: bad confidence")
        if i.get("kind") not in {"technique", "intent", "tooling"}:
            errs.append(f"inference {iid}: kind must be technique|intent|tooling")
        if not i.get("based_on") or any(b not in ids for b in i["based_on"]):
            errs.append(f"inference {iid}: based_on must reference existing observation ids")
    if not d["observations"]:
        errs.append("no observations")
    return errs


def validate_session(session: Path) -> dict:
    session = Path(session)
    an, prep = session / "analysis", session / "analysis" / "prep"
    vids = [p.stem for p in list_video_files(session)]
    per: dict[str, dict] = {}
    for v in vids:
        f = an / "videos" / f"{v}.json"
        if not f.exists():
            per[v] = {"state": "missing", "errors": []}
            continue
        errs = validate_video(f, prep)
        per[v] = {"state": "valid" if not errs else "invalid", "errors": errs}
    valid = sum(1 for r in per.values() if r["state"] == "valid")
    cross = {"patterns": (an / "patterns.json").exists(), "report": (an / "report.md").exists(),
             "design_languages": len(list((an / "design-languages").glob("*.json"))) if (an / "design-languages").is_dir() else 0,
             "recipes": len(list((an / "recipes").glob("*.md"))) if (an / "recipes").is_dir() else 0}
    pat = read_json(an / "patterns.json", {}) or {}
    cross_errs = []
    for p in pat.get("patterns", []):
        for v in p.get("supporting_videos", []):
            if v.get("video") not in vids:
                cross_errs.append(f"pattern {p.get('id')}: unknown video {v.get('video')}")
    if not vids:
        state = "empty"
    elif valid == 0 and not cross["report"]:
        state = "not started" if not any(r["state"] != "missing" for r in per.values()) else "in progress"
    elif valid == len(vids) and cross["patterns"] and cross["report"] and not cross_errs:
        state = "complete"
    else:
        state = "in progress"
    st = {"state": state, "videos_total": len(vids), "videos_valid": valid, "cross": cross, "cross_errors": cross_errs,
          "per_video": per}
    return st


def short_status(session: Path) -> str:
    """Cheap, existence-based status for listings."""
    session = Path(session)
    n = len(list_video_files(session))
    done = len(list((session / "analysis" / "videos").glob("*.json"))) if (session / "analysis" / "videos").is_dir() else 0
    rep = (session / "analysis" / "report.md").exists()
    if n == 0:
        return "no videos"
    if done == 0:
        return "not analysed"
    if done >= n and rep:
        return f"analysed ({done}/{n})"
    return f"partial ({done}/{n}{'' if rep else ', no report'})"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m vie.validate", description="Validate a session's analysis outputs.")
    ap.add_argument("session")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    st = validate_session(Path(a.session))
    if st["state"] != "empty":
        write_json(Path(a.session) / "analysis" / "status.json", {k: v for k, v in st.items() if k != "per_video"} | {
            "invalid": {v: r["errors"] for v, r in st["per_video"].items() if r["state"] == "invalid"},
            "missing": [v for v, r in st["per_video"].items() if r["state"] == "missing"]})
    if a.json:
        print(json.dumps(st, indent=2))
    else:
        print(f"analysis: {st['state']}  ({st['videos_valid']}/{st['videos_total']} per-video files valid)  cross: {st['cross']}")
        for v, r in st["per_video"].items():
            if r["state"] != "valid":
                print(f"  {v}: {r['state']}")
                for e in r["errors"][:8]:
                    print(f"      - {e}")
        for e in st["cross_errors"]:
            print(f"  - {e}")
    return 0 if st["state"] == "complete" else 1


if __name__ == "__main__":
    sys.exit(main())
