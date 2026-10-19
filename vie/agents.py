"""Detect, select and launch analysis agents (Claude Code, Codex) based on what is really installed."""
from __future__ import annotations

import json
import os
import random
import shutil
import struct
import subprocess
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path

from .util import read_json, write_json


@dataclass
class AgentInfo:
    key: str                 # "claude" | "codex"
    name: str
    binary: str | None
    version: str = ""
    authenticated: bool = False
    model: str = ""          # "" -> the tool's own default
    notes: list[str] = field(default_factory=list)
    vision_probe: dict | None = None   # last recorded real probe result

    @property
    def installed(self) -> bool:
        return bool(self.binary)

    @property
    def usable(self) -> bool:
        return self.installed and self.authenticated


def _run(cmd, timeout=15, **kw):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)
    except (subprocess.TimeoutExpired, OSError) as e:
        return subprocess.CompletedProcess(cmd, 99, "", str(e))


def detect_claude(cfg) -> AgentInfo:
    b = shutil.which("claude")
    a = AgentInfo("claude", "Claude Code", b, model=cfg["analysis"]["claude_model"])
    if not b:
        a.notes.append("not installed")
        return a
    a.version = _run([b, "--version"]).stdout.strip().split("\n")[0]
    if os.environ.get("ANTHROPIC_API_KEY"):
        a.authenticated = True
        a.notes.append("ANTHROPIC_API_KEY set")
    else:
        r = _run([b, "auth", "status"])
        try:
            a.authenticated = bool(json.loads(r.stdout).get("loggedIn"))
        except (json.JSONDecodeError, ValueError):
            a.authenticated = r.returncode == 0 and "logged in" in r.stdout.lower()
        if not a.authenticated:
            a.notes.append("not logged in: run `claude` and /login")
    return a


def detect_codex(cfg) -> AgentInfo:
    b = shutil.which("codex")
    a = AgentInfo("codex", "Codex", b, model=cfg["analysis"]["codex_model"])
    if not b:
        a.notes.append("not installed")
        return a
    a.version = _run([b, "--version"]).stdout.strip()
    r = _run([b, "login", "status"])
    a.authenticated = r.returncode == 0 or bool(os.environ.get("OPENAI_API_KEY"))
    if not a.authenticated:
        a.notes.append("not logged in: run `codex login`")
    return a


def detect_agents(cfg) -> dict[str, AgentInfo]:
    agents = {"claude": detect_claude(cfg), "codex": detect_codex(cfg)}
    probes = read_json(cfg.state_dir / "probes.json", {}) or {}
    for k, a in agents.items():
        a.vision_probe = probes.get(k)
    return agents


def choose_auto(agents: dict[str, AgentInfo], cfg) -> tuple[AgentInfo, str]:
    """Pick from what is installed+authenticated, preferring agents whose real vision probe passed."""
    order = [k for k in cfg["analysis"]["auto_order"] if k in agents]
    usable = [agents[k] for k in order if agents[k].usable]
    if not usable:
        raise RuntimeError("no usable analysis agent: " + "; ".join(
            f"{a.name}: {', '.join(a.notes) or 'unavailable'}" for a in agents.values()))
    passed = [a for a in usable if a.vision_probe and a.vision_probe.get("passed")]
    failed = {a.key for a in usable if a.vision_probe and a.vision_probe.get("passed") is False}
    pool = passed or [a for a in usable if a.key not in failed] or usable
    pick = pool[0]
    why = [f"{pick.name} is installed and logged in"]
    if pick in passed:
        why.append("its image-understanding probe passed")
    else:
        why.append("image understanding not probed yet (run --probe to verify)")
    others = [a.name for a in usable if a is not pick]
    if others:
        why.append(f"preferred over {', '.join(others)} by analysis.auto_order={order}")
    return pick, "; ".join(why)


# ---- real vision probe ------------------------------------------------------------------------------
def _png(rgb, size=96) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def probe_vision(agent: AgentInfo, cfg, workdir: Path) -> dict:
    """Ask the agent (headless, one cheap call) to name the colour of a generated image."""
    colors = {"red": (220, 20, 20), "green": (20, 180, 40), "blue": (30, 60, 220), "yellow": (240, 220, 20)}
    name = random.choice(list(colors))
    workdir.mkdir(parents=True, exist_ok=True)
    img = workdir / "probe.png"
    img.write_bytes(_png(colors[name]))
    q = f"Look at the image file {img.name}. Reply with exactly one word: its dominant colour (red, green, blue or yellow)."
    if agent.key == "claude":
        cmd = [agent.binary, "-p", q, "--allowedTools", "Read", "--permission-mode", "acceptEdits"]
        if agent.model: cmd += ["--model", agent.model]
    else:
        cmd = [agent.binary, "exec", q, "-C", str(workdir), "-s", "read-only", "--skip-git-repo-check", "-i", str(img)]  # -i is variadic: prompt first
        if agent.model: cmd += ["-m", agent.model]
    t0 = time.time()
    r = _run(cmd, timeout=180, cwd=workdir, stdin=subprocess.DEVNULL)
    out = (r.stdout or "").lower()
    res = {"passed": name in out and sum(c in out for c in colors) == 1 or (name in out.split()[-3:] if out.split() else False),
           "expected": name, "returncode": r.returncode, "seconds": round(time.time() - t0, 1),
           "reply_tail": (r.stdout or r.stderr or "").strip()[-120:], "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    probes = read_json(cfg.state_dir / "probes.json", {}) or {}
    probes[agent.key] = res
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    write_json(cfg.state_dir / "probes.json", probes)
    return res


# ---- launch --------------------------------------------------------------------------------------------
def build_command(agent: AgentInfo, cfg, session_dir: Path, prompt: str, root: Path) -> list[str]:
    perm = cfg["analysis"]["permissions"]
    vie = str(root / "vie.sh")
    if agent.key == "claude":
        cmd = [agent.binary, prompt]  # prompt first: --allowedTools is variadic
        if agent.model:
            cmd += ["--model", agent.model]
        if perm == "scoped":
            cmd += ["--permission-mode", "acceptEdits", "--allowedTools", "Read", "Write", "Edit", "Glob", "Grep",
                    f"Bash({vie} *)", "Bash(ffmpeg *)", "Bash(ffprobe *)", "Bash(ls *)", "Bash(mkdir *)", "Bash(cat *)"]
        return cmd
    cmd = [agent.binary, "-C", str(session_dir)]
    if perm == "scoped":
        cmd += ["-s", "workspace-write", "-a", "on-request"]
    if agent.model:
        cmd += ["-m", agent.model]
    return cmd + [prompt]


def render_prompt(root: Path, session_dir: Path, video_ids: list[str]) -> str:
    from datetime import date
    tpl = (root / "vie" / "prompts" / "analysis.md").read_text(encoding="utf-8")
    return tpl.format(session_id=session_dir.name, session_dir=str(session_dir), n_videos=len(video_ids),
                      video_ids=", ".join(video_ids), vie=str(root / "vie.sh"), today=date.today().isoformat())
