"""Configuration: defaults <- config.toml <- environment. No secrets live here."""
from __future__ import annotations

import copy
import os
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULTS: dict = {
    "paths": {"sessions_dir": "scroll-sessions", "state_dir": "~/.local/share/visualintelligence-engine"},
    "instagram": {
        "account": "your_instagram_username",
        "base_url": "https://www.instagram.com",
        "start_url": "https://www.instagram.com/reels/",
        "login_timeout_s": 1800,
    },
    "browser": {
        "headless": False, "channel": "", "viewport": [1280, 900], "max_restarts": 5,
        "gpu": "software",          # software (default: no GPU video decode/compositing) | auto (Chromium default)
        "mute": True,
        "max_tabs": 3,              # extra tabs beyond this are closed
        "recycle_after_reels": 60,  # restart OUR browser (profile + login persist) every N reels ...
        "recycle_after_min": 20,    # ... or N minutes, whichever comes first; 0 disables
    },
    "llm": {
        "api": "sarness",  # "sarness" (reuses your Sarness Desktop profile+keyring token) | "openai" | "ollama"
        "endpoint": "",  # "" = taken from the Sarness profile (currently 192.168.1.60:8742)
        "sarness_profile": "",  # "" = the profile active in Sarness Desktop
        "api_key_env": "VIE_LLM_API_KEY",  # optional env override of the token
        "model": "",  # "" = smallest model the server offers
        "timeout_s": 90,
        "temperature": 0.4,
        "interest": "Motion graphics, 2D/3D animation, VFX, advertising and product films, filmmaking, "
        "title design and kinetic typography, creative production. Skip memes, vlogs and talking heads.",
    },
    "collector": {
        "max_videos": 0,
        "max_minutes": 0,
        "dwell_s": [3.0, 9.0],
        "open_permalink": True,
        "download_retries": 3,
        "retry_backoff_s": [5, 20, 60],
        "download_timeout_s": 300,
        "dedupe_across_sessions": True,
        "max_consecutive_failures": 8,
        "explore_rate": 0.25,
        "mode": "fast",                 # fast | normal | (train is a separate workflow)
        "fast_dwell_s": [5.0, 7.0],     # time on each reel in fast mode
        "download_workers": 2,          # concurrent downloads in fast mode (be conservative)
        "max_download_workers": 4,      # hard cap whatever --workers says
        "download_nice": 10,            # yt-dlp/ffmpeg children run at lower CPU priority
        "queue_max": 40,                # browsing pauses if this many downloads are waiting
        "cookie_refresh_s": 45,
        "progress_every_s": 10,
        "creator_reels_limit": 12,      # reels per creator profile for --source creators
        "creators_max": 20,
        "grid_scroll_pause_s": 1.4,
        "format": "bestvideo*+bestaudio/best",
    },
    "limits": {},                       # resource guard thresholds; defaults live in vie/resources.py LIMIT_DEFAULTS
    "analysis": {"auto_order": ["claude", "codex"], "claude_model": "", "codex_model": "", "permissions": "scoped"},
    "train": {"dwell_s": [6.0, 12.0], "dry_run": False},
    "prep": {"max_frames": 40, "frame_width": 768, "scene_threshold": 0.30},
}


def _merge(base: dict, over: dict) -> dict:
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


class Config:
    def __init__(self, data: dict, root: Path = ROOT):
        self.data = data
        self.root = root

    def __getitem__(self, key: str) -> dict:
        return self.data[key]

    @property
    def sessions_dir(self) -> Path:
        p = Path(self.data["paths"]["sessions_dir"]).expanduser()
        return p if p.is_absolute() else self.root / p

    @property
    def state_dir(self) -> Path:
        return Path(self.data["paths"]["state_dir"]).expanduser()

    def public_snapshot(self) -> dict:
        """Config safe to store in session.json (contains no credentials by construction)."""
        return copy.deepcopy(self.data)


def load_config(path: str | os.PathLike | None = None, root: Path = ROOT, env=None) -> Config:
    env = os.environ if env is None else env
    data = copy.deepcopy(DEFAULTS)
    cfg_path = Path(path or env.get("VIE_CONFIG") or root / "config.toml")
    if cfg_path.is_file():
        with open(cfg_path, "rb") as f:
            _merge(data, tomllib.load(f))
    elif path:
        raise FileNotFoundError(f"config file not found: {cfg_path}")
    overrides = {
        "VIE_LLM_ENDPOINT": ("llm", "endpoint"),
        "VIE_LLM_MODEL": ("llm", "model"),
        "VIE_SESSIONS_DIR": ("paths", "sessions_dir"),
        "VIE_STATE_DIR": ("paths", "state_dir"),
    }
    for var, (sec, key) in overrides.items():
        if env.get(var):
            data[sec][key] = env[var]
    return Config(data, root)
