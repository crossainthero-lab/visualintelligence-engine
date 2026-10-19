"""./analyse.sh entry point: pick a Scroll Session, pick an agent, launch it in this terminal."""
from __future__ import annotations

import argparse
import hashlib
import json
import signal
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from .agents import (AgentInfo, build_command, choose_auto, detect_agents, probe_vision, render_prompt)
from .config import load_config
from .prep import prep_session
from .sessions import list_video_files, session_dirs
from .util import read_json, setup_logging, write_json
from .validate import short_status, validate_session


def _alive(pid) -> bool:
    try:
        import os
        os.kill(int(pid), 0)
        return True
    except (TypeError, ValueError, ProcessLookupError):
        return False
    except PermissionError:
        return True


def session_rows(cfg) -> list[dict]:
    rows = []
    for d in session_dirs(cfg.sessions_dir):
        info = read_json(d / "session.json", {}) or {}
        status = info.get("status", "?")
        if status == "running" and not _alive(info.get("pid")):
            status = "crashed"  # collector died without finalising (kill -9, power loss, tool interrupt)
        rows.append({"id": d.name, "path": d, "videos": len(list_video_files(d)), "collect": status,
                     "analysis": short_status(d), "started": info.get("started_at", "")[:16].replace("T", " ")})
    return rows


def print_sessions(rows):
    if not rows:
        print("No Scroll Sessions yet. Run ./collect.sh first.")
        return
    print(f"\n  {'#':>2}  {'session':<18} {'started':<16} {'videos':>6}  {'collection':<12} analysis")
    for i, r in enumerate(rows, 1):
        print(f"  {i:>2}  {r['id']:<18} {r['started']:<16} {r['videos']:>6}  {r['collect']:<12} {r['analysis']}")
    print()


def ask(prompt: str, default: str = "") -> str:
    try:
        v = input(prompt).strip()
    except EOFError:
        raise SystemExit("\nno input available (use --session/--agent for non-interactive use)")
    return v or default


def pick_session(rows, arg):
    if arg:
        if arg == "latest":
            cand = [r for r in rows if r["videos"]] or rows
            return cand[-1] if cand else None
        m = [r for r in rows if r["id"] == arg or r["id"].startswith(arg)]
        return m[0] if len(m) == 1 else None
    default = max((i for i, r in enumerate(rows, 1) if r["videos"]), default=len(rows))
    while True:
        v = ask(f"Session to analyse [1-{len(rows)}, Enter = {default}, q = quit]: ", str(default))
        if v.lower() in ("q", "quit"):
            return None
        if v.isdigit() and 1 <= int(v) <= len(rows):
            return rows[int(v) - 1]
        print("  not a valid choice")


def describe(a: AgentInfo) -> str:
    st = "ready" if a.usable else ("not logged in" if a.installed else "not installed")
    pr = ""
    if a.vision_probe:
        pr = f", vision probe {'PASSED' if a.vision_probe.get('passed') else 'FAILED'} ({a.vision_probe.get('at', '')[:10]})"
    return f"{st}{(' - ' + a.version) if a.version else ''}{pr}"


def pick_agent(agents, arg, cfg):
    if arg:
        choice = arg
    else:
        print("Analysis agent:")
        print(f"  1) Claude Code  [{describe(agents['claude'])}]")
        print(f"  2) Codex        [{describe(agents['codex'])}]")
        print("  3) Auto         [pick from what is installed, logged in and verified]")
        while True:
            v = ask("Choose [1-3, Enter = 3]: ", "3").lower()
            choice = {"1": "claude", "2": "codex", "3": "auto"}.get(v, v)
            if choice in ("claude", "codex", "auto"):
                break
            print("  not a valid choice")
    if choice == "auto":
        return choose_auto(agents, cfg)
    a = agents[choice]
    if not a.usable:
        raise SystemExit(f"{a.name} is not usable: {', '.join(a.notes) or 'unavailable'}")
    return a, "chosen explicitly"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="analyse.sh", description="Analyse a Scroll Session with Claude Code or Codex.")
    ap.add_argument("--session", help="session id, prefix, or 'latest' (skips the menu)")
    ap.add_argument("--agent", choices=["claude", "codex", "auto"], help="skip the agent menu")
    ap.add_argument("--list", action="store_true", help="list sessions and exit")
    ap.add_argument("--probe", action="store_true", help="really test each agent's image understanding, then exit")
    ap.add_argument("--dry-run", action="store_true", help="prep + show the command, do not launch the agent")
    ap.add_argument("--no-prep", action="store_true", help="skip FFmpeg pre-processing")
    ap.add_argument("--export", action="store_true", help="write the cross-session dataset JSONL and exit")
    ap.add_argument("--config")
    ap.add_argument("-y", "--yes", action="store_true", help="do not ask for confirmation")
    a = ap.parse_args(argv)
    cfg = load_config(a.config)
    setup_logging()

    if a.export:
        from .export import export
        print(json.dumps(export(cfg.sessions_dir, cfg.root / "dataset" / "observations.jsonl")))
        return 0
    agents = detect_agents(cfg)
    if a.probe:
        for ag in agents.values():
            if not ag.usable:
                print(f"{ag.name}: skipped ({describe(ag)})"); continue
            print(f"{ag.name}: probing image understanding (one small real call)...", flush=True)
            r = probe_vision(ag, cfg, cfg.state_dir / "probe")
            print(f"  {'PASSED' if r['passed'] else 'FAILED'}: expected '{r['expected']}', reply: {r['reply_tail']!r} ({r['seconds']}s)")
        return 0

    rows = session_rows(cfg)
    print("\nVisual Intelligence - analysis")
    print_sessions(rows)
    if a.list or not rows:
        return 0
    row = pick_session(rows, a.session)
    if not row:
        print("No session selected.")
        return 1 if a.session else 0
    if row["videos"] == 0:
        print(f"Session {row['id']} has no videos; nothing to analyse.")
        return 1
    sdir: Path = row["path"]
    agent, why = pick_agent(agents, a.agent, cfg)
    print(f"\nSession : {row['id']} ({row['videos']} videos, analysis: {row['analysis']})")
    print(f"Agent   : {agent.name}{(' / ' + agent.model) if agent.model else ''}  - {why}")
    if row["analysis"].startswith(("partial", "analysed")):
        print("Existing valid per-video analyses are kept; the agent resumes what is missing.")
    if not (a.yes or a.dry_run) and ask("Start? [Y/n]: ", "y").lower() not in ("y", "yes"):
        return 0

    if not a.no_prep:
        print("\nPreparing frames, cuts and audio facts with FFmpeg (no AI)...")
        res = prep_session(sdir, cfg["prep"])
        print(f"  prepared {len(res['ok'])}/{row['videos']} videos" + (f"; FAILED: {res['failed']}" if res["failed"] else ""))
    ids = [p.stem for p in list_video_files(sdir)]
    prompt = render_prompt(cfg.root, sdir, ids)
    an = sdir / "analysis"
    an.mkdir(exist_ok=True)
    (an / "PROMPT.md").write_text(prompt, encoding="utf-8")
    cmd = build_command(agent, cfg, sdir, prompt, cfg.root)
    shown = [c if c != prompt else f"<prompt: {len(prompt)} chars, saved to analysis/PROMPT.md>" for c in cmd]
    launch = {"agent": agent.key, "model": agent.model or "(tool default)", "tool_version": agent.version,
              "selection": why, "command": shown, "started_at": datetime.now().astimezone().isoformat(timespec="seconds"),
              "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "cwd": str(sdir)}
    write_json(an / "launch.json", launch)
    print(f"\nLaunching {agent.name} in {sdir}\n  $ {' '.join(shown)}\n")
    if a.dry_run:
        print("(dry run: agent not launched)")
        return 0
    old = signal.signal(signal.SIGINT, signal.SIG_IGN)  # Ctrl+C belongs to the agent UI while it runs
    try:
        rc = subprocess.run(cmd, cwd=sdir).returncode
    finally:
        signal.signal(signal.SIGINT, old)
    launch.update(ended_at=datetime.now().astimezone().isoformat(timespec="seconds"), exit_code=rc)
    write_json(an / "launch.json", launch)
    st = validate_session(sdir)
    print(f"\n{agent.name} exited ({rc}). Analysis state: {st['state']} - {st['videos_valid']}/{st['videos_total']} per-video files valid.")
    for v, r in st["per_video"].items():
        if r["state"] == "invalid":
            print(f"  {v}: invalid -> {r['errors'][:2]}")
    if st["state"] != "complete":
        print("Run ./analyse.sh again later to resume; valid work is kept.")
    print(f"Outputs: {an}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
