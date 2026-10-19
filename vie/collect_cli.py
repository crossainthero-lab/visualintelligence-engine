"""./collect.sh entry point."""
from __future__ import annotations

import argparse
import os
import shutil
import sys

from .config import load_config
from .util import LOG, setup_logging


def check(cfg) -> int:
    from .steer import LLMClient, LLMError
    ok = True
    def line(name, good, detail=""):
        nonlocal ok
        ok &= bool(good)
        print(f"  [{'ok' if good else '!!'}] {name:<18} {detail}")
    print("Preflight")
    mode = cfg["collector"]["mode"]
    line("ffmpeg/ffprobe", shutil.which("ffmpeg") and shutil.which("ffprobe"), shutil.which("ffmpeg") or "missing")
    try:
        import playwright, yt_dlp  # noqa: F401
        line("playwright, yt-dlp", True, "importable")
    except ImportError as e:
        line("playwright, yt-dlp", False, f"{e} (run ./setup.sh)")
    from .steer import build_client
    if mode == "fast":
        line("LLM", True, "not used in fast mode (collection never calls an LLM); only --mode normal/train do")
    else:
        try:
            c = build_client(cfg)
            line("LLM token", bool(c.api_key) or c.api == "ollama", f"{c.api}: " + ("present (not shown)" if c.api_key else "MISSING"))
            m = c.resolve_model()
            line("LLM server", True, f"{c.endpoint} model={m}")
        except LLMError as e:
            line("LLM server", False, f"{e}  (collector would use keyword heuristics)")
    from .resources import take_sample, evaluate, LIMIT_DEFAULTS
    smp = take_sample(set(), cfg.sessions_dir.parent if not cfg.sessions_dir.exists() else cfg.sessions_dir)
    ver = evaluate(smp, {**LIMIT_DEFAULTS, **cfg["limits"]})
    line("Resources", ver.action == "ok", f"RAM free {smp.mem_available_mb or 0:.0f} MB, swap {smp.swap_used_pct or 0:.0f}%, "
         f"disk free {smp.disk_free_gb or 0:.1f} GB, GPU {smp.gpu_name or 'n/a'} {smp.gpu_used_pct or 0:.0f}% used"
         + (f"  PRESSURE: {'; '.join(ver.reasons)}" if ver.reasons else ""))
    prof = cfg.state_dir / "browser-profile"
    line("Instagram profile", prof.exists(), f"{prof} " + ("(saved; login will be reused)" if prof.exists() else "(first run: you will log in manually)"))
    line("Sessions dir", True, str(cfg.sessions_dir))
    return 0 if ok else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="collect.sh", description="Start a new Scroll Session (Ctrl+C to stop).")
    ap.add_argument("--mode", choices=["fast", "normal", "train"], help="fast (default): glance 5-7 s + queue downloads; "
                    "normal: LLM-steered, watch each reel; train: interactive feed training (approve every action)")
    ap.add_argument("--source", choices=["reels", "saved", "creators"], default="reels",
                    help="reels = your Reels feed (default); saved = your Saved collection(s); "
                    "creators = public Reels of creators found in your Saved references")
    ap.add_argument("--creators", help="with --source creators: comma-separated handles (default: from Saved sessions)")
    ap.add_argument("--limit", type=int, help="max items per collection / creator")
    ap.add_argument("--resume", nargs="?", const="latest", metavar="SESSION",
                    help="finish queued/failed downloads of an earlier session (default: latest unfinished)")
    ap.add_argument("--workers", type=int, help="concurrent downloads in fast mode (default 2)")
    ap.add_argument("--dry-run", action="store_true", help="with --mode train: highlight targets, never click")
    ap.add_argument("--config")
    ap.add_argument("--max-videos", type=int, help="stop after N downloads")
    ap.add_argument("--minutes", type=float, help="stop after N minutes")
    ap.add_argument("--endpoint", help="LLM endpoint override")
    ap.add_argument("--model", help="LLM model name")
    ap.add_argument("--no-llm", action="store_true", help="use keyword heuristics only (normal/train modes)")
    ap.add_argument("--headless", action="store_true", help="(testing only) hide the browser")
    ap.add_argument("--start-url", help="override the feed URL (testing)")
    ap.add_argument("--check", action="store_true", help="preflight checks, then exit")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)

    cfg = load_config(a.config)
    if a.endpoint: cfg["llm"]["endpoint"] = a.endpoint
    if a.model: cfg["llm"]["model"] = a.model
    if a.max_videos is not None: cfg["collector"]["max_videos"] = a.max_videos
    if a.minutes is not None: cfg["collector"]["max_minutes"] = a.minutes
    if a.workers: cfg["collector"]["download_workers"] = a.workers
    if a.start_url: cfg["instagram"]["start_url"] = a.start_url
    mode = a.mode or cfg["collector"]["mode"]
    cfg["collector"]["mode"] = mode
    setup_logging(verbose=a.verbose)
    if a.check:
        return check(cfg)

    from .resources import AlreadyRunning, InstanceLock
    lock = InstanceLock(cfg.state_dir)
    try:
        lock.acquire()  # one collector at a time: two visible Chromiums + decoders is how desktops freeze
    except AlreadyRunning as e:
        print(f"error: {e}", file=sys.stderr)
        return 3
    try:
        return _run(a, cfg, mode)
    finally:
        lock.release()


def _run(a, cfg, mode: str) -> int:
    from .browser import BrowserSession
    browser = BrowserSession(cfg, headless=True if a.headless else None)
    if mode == "train":
        from .steer import LLMError, build_client
        from .train import run_training
        client = None
        if not a.no_llm:
            try:
                client = build_client(cfg)
                client.resolve_model()
            except LLMError as e:
                print(f"LLM unavailable ({e}); suggestions disabled, you decide manually.")
                client = None
        return run_training(cfg, browser, client, dry_run=a.dry_run or cfg["train"]["dry_run"])

    from .collector import Collector
    from .sessions import session_dirs
    from .steer import build_steering
    steering = build_steering(cfg, force_heuristic=True) if mode == "fast" or a.no_llm else build_steering(cfg)
    creators = [c.strip().lstrip("@") for c in a.creators.split(",")] if a.creators else None
    col = Collector(cfg, steering, browser, mode=mode, source=a.source, creators=creators, limit=a.limit)
    resume = None
    if a.resume:
        dirs = session_dirs(cfg.sessions_dir)
        pick = [d for d in dirs if d.name == a.resume] if a.resume != "latest" else \
            [d for d in reversed(dirs) if _unfinished(d)][:1]
        if not pick:
            print("No session with unfinished downloads found.")
            return 1
        resume = pick[0]
    s = col.run(resume=resume)
    return 0 if s.info["status"] in ("completed", "interrupted") else 1


def _unfinished(d) -> bool:
    from .util import read_json
    meta = read_json(d / "metadata.json", {}) or {}
    return any(e.get("status") in ("queued", "downloading", "interrupted", "failed") for e in meta.get("videos", []))


if __name__ == "__main__":
    sys.exit(main())
