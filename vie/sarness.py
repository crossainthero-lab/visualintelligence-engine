"""Reuse the existing Sarness Desktop connection: profile from ~/.config/sarness/profiles.json and the API
token from the same OS keyring entry the app uses (service "sarness", account = profile id).

The token is read at runtime only, never written anywhere by this project, and registered for log redaction.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from .util import register_secret

PROFILES = Path("~/.config/sarness/profiles.json").expanduser()
FALLBACK = Path("~/.config/sarness/secrets.json").expanduser()  # Sarness's own 0600 fallback when no keyring


@dataclass
class SarnessConn:
    base_url: str
    token: str
    profile_name: str
    token_source: str


def find_profile(name: str = "") -> dict | None:
    try:
        data = json.loads(PROFILES.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    profiles = data.get("profiles", [])
    if name:
        return next((p for p in profiles if p.get("name") == name or p.get("id") == name), None)
    return next((p for p in profiles if p.get("id") == data.get("active")), profiles[0] if profiles else None)


def read_token(profile_id: str) -> tuple[str, str]:
    """Return (token, source). Source names where it came from, never the value."""
    try:
        import keyring
        t = keyring.get_password("sarness", profile_id)
        if t:
            return t, "OS keyring (Sarness entry)"
    except Exception:  # noqa: BLE001 - no backend / locked keyring
        pass
    try:
        t = json.loads(FALLBACK.read_text()).get(profile_id)
        if t:
            return t, f"{FALLBACK}"
    except (OSError, json.JSONDecodeError):
        pass
    return "", ""


def connection(cfg_llm: dict, env=None) -> SarnessConn | None:
    """Endpoint + token for the configured Sarness profile. Env var overrides the token."""
    env = os.environ if env is None else env
    prof = find_profile(cfg_llm.get("sarness_profile", ""))
    endpoint = cfg_llm.get("endpoint") or ""
    if not endpoint and prof:
        endpoint = f"{prof.get('scheme', 'http')}://{prof['host']}:{prof['port']}"
    if not endpoint:
        return None
    token, src = env.get(cfg_llm.get("api_key_env") or "", ""), "environment variable"
    if not token:
        token, src = read_token(prof["id"]) if prof else ("", "")
    if token:
        register_secret(token)
    return SarnessConn(endpoint.rstrip("/"), token, (prof or {}).get("name", "?"), src or "none")
