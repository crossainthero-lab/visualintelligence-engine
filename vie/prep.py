"""Deterministic FFmpeg/numpy pre-processing for analysis. No AI, no guessing.

For each video it writes analysis/prep/<id>/ with:
  facts.json       measured facts: probe, cuts/shots, rhythm, palette, audio stats (compact: safe to Read)
  timelines.json   per-12fps luma/contrast/saturation/rgb/motion_energy arrays (large)
  frames/*.jpg     timestamped stills (file name carries the time) for the multimodal agent to LOOK at
  audio.wav        16 kHz mono audio (for any ASR / listening tool the agent has)
  spectrogram.png, waveform.png
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

from .sessions import list_video_files
from .util import LOG, ffprobe, need, read_json, video_summary, write_json

TL_FPS = 12
TL_W = 96


def _run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, **kw)


# ---------------------------------------------------------------------------------------------
def detect_cuts(video: Path, threshold: float) -> list[dict]:
    """Hard cuts via ffmpeg's scene score, with exact presentation timestamps."""
    r = _run([need("ffmpeg"), "-nostats", "-i", str(video), "-an", "-vf",
              f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"], text=True)
    cuts = []
    for m in re.finditer(r"pts_time:([\d.]+)", r.stderr):
        t = float(m.group(1))
        if t > 0.05 and (not cuts or t - cuts[-1]["t"] > 0.15):
            cuts.append({"t": round(t, 3)})
    # scene scores for strength ranking
    r2 = _run([need("ffmpeg"), "-nostats", "-i", str(video), "-an", "-vf",
               f"select='gt(scene,{threshold})',metadata=print:key=lavfi.scene_score", "-f", "null", "-"], text=True)
    scores = [float(x) for x in re.findall(r"scene_score=([\d.]+)", r2.stderr)]
    ts = [float(x) for x in re.findall(r"pts_time:([\d.]+)", r2.stderr)]
    for c in cuts:
        near = [s for t, s in zip(ts, scores) if abs(t - c["t"]) < 0.2]
        c["strength"] = round(max(near), 3) if near else None
    return cuts


def timelines(video: Path, summary: dict) -> dict:
    """Low-res decode -> per-sample luma/colour/saturation and frame-to-frame motion energy."""
    w, h = summary["width"], summary["height"]
    th = max(2, int(round(TL_W * h / w / 2)) * 2)
    cmd = [need("ffmpeg"), "-v", "error", "-i", str(video), "-an", "-vf", f"fps={TL_FPS},scale={TL_W}:{th}:flags=area",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    fsz = TL_W * th * 3
    n = len(raw) // fsz
    if n == 0:
        return {"samples": 0}
    a = np.frombuffer(raw[: n * fsz], np.uint8).reshape(n, th, TL_W, 3).astype(np.float32) / 255
    luma = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    mx, mn = a.max(-1), a.min(-1)
    sat = np.where(mx > 1e-3, (mx - mn) / np.maximum(mx, 1e-3), 0)
    motion = np.zeros(n, np.float32)
    motion[1:] = np.abs(np.diff(luma, axis=0)).mean(axis=(1, 2))
    q = (a * 15.999).astype(np.uint8).reshape(-1, 3)
    codes = q[:, 0].astype(np.int32) * 256 + q[:, 1] * 16 + q[:, 2]
    uniq, cnt = np.unique(codes, return_counts=True)
    top = np.argsort(-cnt)[:6]
    palette = []
    for i in top:
        u = int(uniq[i])
        rgb = [int((c + 0.5) * 16) for c in (u // 256, (u // 16) % 16, u % 16)]
        palette.append({"hex": "#%02x%02x%02x" % tuple(rgb), "share": round(float(cnt[i] / cnt.sum()), 3)})
    return {
        "samples": int(n), "fps": TL_FPS,
        "t": [round(i / TL_FPS, 3) for i in range(n)],
        "mean_luma": np.round(luma.mean((1, 2)), 3).tolist(),
        "contrast": np.round(luma.std((1, 2)), 3).tolist(),
        "mean_saturation": np.round(sat.mean((1, 2)), 3).tolist(),
        "mean_rgb": np.round(a.mean((1, 2)), 3).tolist(),
        "motion_energy": np.round(motion, 4).tolist(),
        "palette": palette,
        "overall": {"mean_luma": round(float(luma.mean()), 3), "mean_saturation": round(float(sat.mean()), 3),
                    "contrast": round(float(luma.std((1, 2)).mean()), 3), "motion_energy_mean": round(float(motion.mean()), 4)},
    }


def shots_from(cuts: list[dict], duration: float, tl: dict) -> list[dict]:
    bounds = [0.0, *[c["t"] for c in cuts], duration]
    out = []
    for i in range(len(bounds) - 1):
        s, e = bounds[i], bounds[i + 1]
        if e - s <= 0:
            continue
        shot = {"index": len(out) + 1, "start": round(s, 3), "end": round(e, 3), "duration": round(e - s, 3)}
        if tl.get("samples"):
            idx = [j for j, t in enumerate(tl["t"]) if s + 0.1 <= t < e]
            if idx:
                shot["mean_motion_energy"] = round(float(np.mean([tl["motion_energy"][j] for j in idx])), 4)
                shot["mean_luma"] = round(float(np.mean([tl["mean_luma"][j] for j in idx])), 3)
                shot["mean_rgb"] = np.round(np.mean([tl["mean_rgb"][j] for j in idx], axis=0), 3).tolist()
        out.append(shot)
    return out


def rhythm(shots: list[dict], duration: float) -> dict:
    d = [s["duration"] for s in shots]
    r = {"shot_count": len(d), "cuts": max(0, len(d) - 1), "cuts_per_minute": round((len(d) - 1) / duration * 60, 1) if duration else 0,
         "average_shot_length_s": round(float(np.mean(d)), 3), "median_shot_length_s": round(float(np.median(d)), 3),
         "shortest_s": round(min(d), 3), "longest_s": round(max(d), 3)}
    if len(d) >= 4:
        h = len(d) // 2
        r["asl_first_half_s"], r["asl_second_half_s"] = round(float(np.mean(d[:h])), 3), round(float(np.mean(d[h:])), 3)
    return r


def audio_facts(video: Path, outdir: Path, cuts: list[dict], summary: dict) -> dict:
    if not summary["has_audio"]:
        return {"present": False}
    wav = outdir / "audio.wav"
    _run([need("ffmpeg"), "-v", "error", "-y", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000", str(wav)])
    facts: dict = {"present": True, "file": "audio.wav", "transcript": None,
                   "note": "No ASR/listening is performed by prep. Lyrics, speech and music identity are UNKNOWN unless a tool reports them."}
    r = _run([need("ffmpeg"), "-nostats", "-i", str(video), "-vn", "-af", "ebur128=peak=true,silencedetect=n=-45dB:d=0.25",
              "-f", "null", "-"], text=True)
    err = r.stderr
    m = re.search(r"Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS.*?Loudness range:\s+LRA:\s+([\d.]+) LU", err, re.S)
    if m:
        facts["integrated_lufs"], facts["loudness_range_lu"] = float(m.group(1)), float(m.group(2))
    p = re.search(r"True peak:\s+Peak:\s+(-?[\d.]+) dBFS", err)
    if p:
        facts["true_peak_dbfs"] = float(p.group(1))
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", err)]
    facts["silences"] = [{"start": round(max(s, 0), 3), "end": round(e, 3)} for s, e in zip(starts, ends)]
    # onsets + tempo estimate from an energy envelope
    try:
        pcm = _run([need("ffmpeg"), "-v", "error", "-i", str(wav), "-f", "s16le", "-ar", "8000", "-ac", "1", "-"]).stdout
        x = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
        hop = 80  # 10 ms
        env = np.sqrt(np.convolve(x * x, np.ones(hop) / hop, "same"))[::hop]
        flux = np.maximum(0, np.diff(env, prepend=env[0]))
        thr = max(flux.mean() + 2.5 * flux.std(), 0.02)
        peaks = [i for i in range(1, len(flux) - 1) if flux[i] > thr and flux[i] >= flux[i - 1] and flux[i] > flux[i + 1]]
        onsets = []
        for i in peaks:
            if not onsets or (i - onsets[-1]) * 0.01 > 0.12:
                onsets.append(i)
        ons = [round(i * 0.01, 2) for i in onsets]
        facts["onsets_s"] = ons[:400]
        facts["onset_count"] = len(ons)
        if len(ons) >= 6:
            ioi = np.diff(ons)
            bpm = 60 / float(np.median(ioi))
            while bpm < 70: bpm *= 2
            while bpm > 180: bpm /= 2
            facts["tempo_estimate_bpm"] = {"value": round(bpm, 1), "basis": "median onset interval", "confidence": "low - verify by ear/other tool"}
        if cuts and ons:
            tol = 0.1
            hit = sum(1 for c in cuts if min(abs(c["t"] - o) for o in ons) <= tol)
            dur = summary["duration_s"]
            chance = min(1.0, len(ons) * 2 * tol / dur) if dur else 0
            facts["cut_audio_sync"] = {"tolerance_s": tol, "cuts_near_onset": hit, "cuts": len(cuts),
                                       "fraction": round(hit / len(cuts), 2), "chance_level": round(chance, 2)}
    except Exception as e:  # noqa: BLE001
        facts["onset_error"] = str(e)
    _run([need("ffmpeg"), "-v", "error", "-y", "-i", str(wav), "-lavfi", "showspectrumpic=s=1024x384:legend=0:scale=log",
          str(outdir / "spectrogram.png")])
    _run([need("ffmpeg"), "-v", "error", "-y", "-i", str(wav), "-lavfi", "showwavespic=s=1024x200",
          "-frames:v", "1", str(outdir / "waveform.png")])
    return facts


def pick_frames(duration: float, shots: list[dict], cuts: list[dict], tl: dict, max_frames: int, fps: float) -> list[dict]:
    pts: dict[float, str] = {}
    def add(t, why):
        t = round(min(max(t, 0.0), max(duration - 0.05, 0)), 2)
        pts.setdefault(t, why)
    add(0.05, "first_frame")
    for s in shots:
        add(s["start"] + min(0.08, s["duration"] / 4), f"shot{s['index']}_start")
        if s["duration"] > 0.6:
            add((s["start"] + s["end"]) / 2, f"shot{s['index']}_mid")
    add(duration - 0.1, "last_frame")
    if len(shots) < 3:  # single-take: sample evenly instead
        for i in range(1, 12):
            add(duration * i / 12, "uniform")
    core = sorted(pts.items())
    if len(core) > max_frames:  # evenly thin, always keeping first/last
        keep = {0, len(core) - 1, *[int(i * (len(core) - 1) / (max_frames - 1)) for i in range(max_frames)]}
        core = [core[i] for i in sorted(keep)]
    extra: dict[float, str] = {}
    fd = 1 / (fps or 24)
    for c in sorted(cuts, key=lambda c: -(c.get("strength") or 0))[:4]:  # the strongest transitions, frame by frame
        for k, off in enumerate((-2 * fd, -fd, 0, fd, 2 * fd, 4 * fd)):
            extra.setdefault(round(max(c["t"] + off, 0), 3), f"transition@{c['t']}")
    if tl.get("samples", 0) > TL_FPS:  # densest motion second: easing/animation curve evidence
        m = np.array(tl["motion_energy"])
        win = np.convolve(m, np.ones(TL_FPS), "valid")
        i0 = int(np.argmax(win)) / TL_FPS
        for k in range(8):
            extra.setdefault(round(min(i0 + k * 0.125, duration - 0.05), 3), f"motion_burst@{round(i0, 2)}")
    allp = dict(core)
    for t, why in extra.items():
        if all(abs(t - u) > 0.01 for u in allp):
            allp[t] = why
    return [{"t": t, "reason": w} for t, w in sorted(allp.items())]


def extract_frames(video: Path, frames: list[dict], outdir: Path, width: int) -> list[dict]:
    outdir.mkdir(parents=True, exist_ok=True)
    out = []
    for f in frames:
        name = f"f_{f['t']:08.3f}s.jpg"
        r = _run([need("ffmpeg"), "-v", "error", "-y", "-ss", f"{f['t']:.3f}", "-i", str(video), "-frames:v", "1",
                  "-vf", f"scale='min({width},iw)':-2", "-q:v", "3", str(outdir / name)])
        if r.returncode == 0 and (outdir / name).exists():
            out.append({"file": f"frames/{name}", "t": f["t"], "reason": f["reason"]})
        else:
            LOG.warning("frame at %.3fs failed for %s", f["t"], video.name)
    return out


def prep_video(video: Path, prep_dir: Path, cfg_prep: dict, force: bool = False) -> dict:
    out = prep_dir / video.stem
    facts_path = out / "facts.json"
    if facts_path.exists() and not force:
        return read_json(facts_path)
    out.mkdir(parents=True, exist_ok=True)
    summary = video_summary(ffprobe(video))
    dur = summary["duration_s"]
    cuts = detect_cuts(video, cfg_prep["scene_threshold"])
    tl = timelines(video, summary)
    shots = shots_from(cuts, dur, tl)
    plan = pick_frames(dur, shots, cuts, tl, cfg_prep["max_frames"], summary["fps"])
    frames = extract_frames(video, plan, out / "frames", cfg_prep["frame_width"])
    facts = {
        "schema": 1, "video": video.stem, "file": f"videos/{video.name}", "probe": summary,
        "cuts": cuts, "shots": shots, "rhythm": rhythm(shots, dur),
        "visual": {"palette": tl.get("palette"), **(tl.get("overall") or {})},
        "timelines_file": "timelines.json",
        "audio": audio_facts(video, out, cuts, summary),
        "frames": frames,
        "limits": ["Cuts are detected hard cuts; dissolves/whips/animated transitions may be missed or split.",
                   "Motion energy is mean luma change between 12 fps samples, not camera/object tracking.",
                   "Nothing here recovers keyframes, project files or production settings."],
    }
    write_json(out / "timelines.json", {k: tl[k] for k in ("fps", "t", "mean_luma", "contrast", "mean_saturation",
                                                          "mean_rgb", "motion_energy") if k in tl})
    write_json(facts_path, facts)  # written last: its presence marks the video as prepared
    return facts


def prep_session(session: Path, cfg_prep: dict, force: bool = False) -> dict:
    session = Path(session)
    prep_dir = session / "analysis" / "prep"
    prep_dir.mkdir(parents=True, exist_ok=True)
    res = {"ok": [], "failed": {}}
    vids = list_video_files(session)
    for i, v in enumerate(vids, 1):
        try:
            print(f"  prep {v.name} ({i}/{len(vids)})", flush=True)
            prep_video(v, prep_dir, cfg_prep, force)
            res["ok"].append(v.stem)
        except Exception as e:  # noqa: BLE001
            LOG.error("prep failed for %s: %s", v.name, e)
            res["failed"][v.stem] = str(e)
    if res["failed"]:
        write_json(prep_dir / "failures.json", res["failed"])
    return res


def main(argv=None) -> int:
    from .config import load_config
    ap = argparse.ArgumentParser(prog="python -m vie.prep")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("session", help="prepare every video in a session (skips already-prepared)")
    p1.add_argument("session"); p1.add_argument("--force", action="store_true")
    p2 = sub.add_parser("frames", help="extract extra frames at given times (seconds) for one video")
    p2.add_argument("session"); p2.add_argument("video_id"); p2.add_argument("--at", type=float, nargs="+", required=True)
    a = ap.parse_args(argv)
    cfg = load_config()
    if a.cmd == "session":
        r = prep_session(Path(a.session), cfg["prep"], a.force)
        print(json.dumps({"prepared": len(r["ok"]), "failed": r["failed"]}))
        return 1 if r["failed"] else 0
    s = Path(a.session)
    v = next((p for p in list_video_files(s) if p.stem == a.video_id), None)
    if not v:
        print(f"no video {a.video_id}", file=sys.stderr); return 2
    fr = extract_frames(v, [{"t": t, "reason": "extra"} for t in a.at], s / "analysis" / "prep" / v.stem / "frames", cfg["prep"]["frame_width"])
    for f in fr: print(f["file"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
