"""The cheap steering agent: decides, from *text only*, whether a discovered reel is worth saving.

Uses a configurable LLM server (OpenAI-compatible or Ollama). If the server is unreachable, falls back to a
keyword heuristic so collection never stalls. It never looks at video content.
"""
from __future__ import annotations

import json
import os
import random
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

from .util import LOG

KEYWORDS = (
    "motion", "animation", "animated", "3d", "vfx", "cgi", "render", "blender", "cinema4d", "c4d", "after effects",
    "aftereffects", "houdini", "unreal", "compositing", "typography", "kinetic", "title", "ad ", "advert",
    "commercial", "campaign", "product film", "film", "cinematic", "cinematography", "director", "behind the scenes",
    "breakdown", "storyboard", "motion design", "branding", "reel", "edit", "visual", "design", "shot",
)
AVOID = ("meme", "funny", "prank", "giveaway", "follow for", "link in bio", "recipe", "gym", "workout")


@dataclass
class Decision:
    action: str          # "download" | "skip"
    reason: str
    dwell_s: float | None = None
    source: str = "heuristic"  # "llm" | "heuristic"


class LLMError(RuntimeError):
    pass


OllamaError = LLMError  # backwards-compatible alias


class LLMClient:
    """Minimal stdlib client for an OpenAI-compatible server (api='openai') or Ollama (api='ollama')."""

    def __init__(self, endpoint: str, model: str = "", timeout: float = 60, temperature: float = 0.4,
                 api: str = "openai", api_key: str = ""):
        self.endpoint = endpoint.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.temperature = temperature
        self.api = api
        self.api_key = api_key
        self._refs: dict[str, str] = {}

    def _req(self, path: str, body: dict | None = None, timeout: float | None = None) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.endpoint + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            hint = " (set the token env var named by llm.api_key_env)" if e.code in (401, 403) else ""
            raise LLMError(f"{self.endpoint}{path}: HTTP {e.code}{hint}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, json.JSONDecodeError) as e:
            raise LLMError(f"{self.endpoint}{path}: {e}") from e

    def models(self) -> list[str]:
        if self.api == "sarness":
            self._refs = {m["name"]: m["ref"] for m in self._req("/v1/agent/models", timeout=8)}
            return list(self._refs)
        if self.api == "ollama":
            return [m["name"] for m in self._req("/api/tags", timeout=5).get("models", [])]
        return [m["id"] for m in self._req("/v1/models", timeout=8).get("data", [])]

    def resolve_model(self) -> str:
        """Use the configured model if the server has it; otherwise the first one it reports."""
        have = self.models()
        if not have:
            raise LLMError("server reachable but reports no models")
        if self.model:
            if self.model in have or f"{self.model}:latest" in have:
                return self.model
            raise LLMError(f"model '{self.model}' not on server; available: {', '.join(have)}")
        if self.api == "sarness":  # no preference given: cheapest = smallest parameter count
            def size(n):
                m = re.search(r"(\d+(?:\.\d+)?)b", n.lower())
                return float(m.group(1)) if m else 1e9
            have = sorted(have, key=size)
        self.model = have[0]
        return self.model

    def _sarness_complete(self, msgs: list[dict]) -> str:
        """POST /v1/agent/completions (stateless, SSE). Returns the final assistant text."""
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        body = {"model_ref": self._refs[self.model], "messages": msgs,
                "params": {"temperature": self.temperature, "max_tokens": 600}}
        req = urllib.request.Request(self.endpoint + "/v1/agent/completions", json.dumps(body).encode(), headers)
        text: list[str] = []
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                for raw in r:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    ev = json.loads(line[5:])
                    if ev.get("type") == "error":
                        raise LLMError(f"server error: {ev.get('message')}")
                    if ev.get("type") == "delta":
                        text.append(ev.get("content") or "")
                    if ev.get("type") == "done":
                        return (ev.get("message") or {}).get("content") or "".join(text)
        except urllib.error.HTTPError as e:
            raise LLMError(f"/v1/agent/completions: HTTP {e.code}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, json.JSONDecodeError) as e:
            raise LLMError(f"/v1/agent/completions: {e}") from e
        return "".join(text)

    def chat_json(self, system: str, user: str) -> dict:
        msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        if self.api == "sarness":
            text = self._sarness_complete(msgs)
        elif self.api == "ollama":
            out = self._req("/api/chat", {"model": self.model, "stream": False, "format": "json", "think": False,
                                          "options": {"temperature": self.temperature, "num_predict": 200},
                                          "messages": msgs})
            text = out.get("message", {}).get("content", "")
        else:
            out = self._req("/v1/chat/completions", {"model": self.model, "temperature": self.temperature,
                                                     "max_tokens": 200, "messages": msgs})
            try:
                text = out["choices"][0]["message"]["content"] or ""
            except (KeyError, IndexError, TypeError) as e:
                raise LLMError(f"unexpected completion payload: {str(out)[:120]}") from e
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise LLMError(f"no JSON in model reply: {text[:120]!r}")
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError as e:
            raise LLMError(f"bad JSON from model: {e}") from e


SYSTEM = """You steer a research collector browsing Instagram Reels. You see only TEXT about the current reel.
Research interest: {interest}
Decide whether to save this reel. Prefer reels likely to show craft in motion design, animation, VFX, advertising,
film or product production. When the text is empty or ambiguous, lean towards "download" (saving is cheap).
Reply with JSON only: {{"action":"download"|"skip","dwell_s":<3-12 seconds to keep watching>,"reason":"<short>"}}"""


class Steering:
    def __init__(self, interest: str, client: LLMClient | None, explore_rate: float = 0.25,
                 dwell: tuple[float, float] = (3, 9), rng: random.Random | None = None, retry_after_s: float = 60):
        self.interest = interest
        self.client = client
        self.explore_rate = explore_rate
        self.dwell = dwell
        self.rng = rng or random.Random()
        self.retry_after_s = retry_after_s
        self._down_until = 0.0
        self.recent: list[str] = []
        self.stats = {"llm": 0, "heuristic": 0}

    def _dwell(self) -> float:
        return round(self.rng.uniform(*self.dwell), 1)

    def heuristic(self, reel: dict) -> Decision:
        text = f"{reel.get('creator') or ''} {reel.get('caption') or ''}".lower()
        if any(a in text for a in AVOID):
            return Decision("skip", "avoid-keyword", self._dwell())
        if any(k in text for k in KEYWORDS):
            return Decision("download", "keyword match", self._dwell())
        if not text.strip():
            return Decision("download", "no text; saving is cheap", self._dwell())
        if self.rng.random() < self.explore_rate:
            return Decision("download", "exploration", self._dwell())
        return Decision("skip", "no interest signal", self._dwell())

    def decide(self, reel: dict, progress: dict) -> Decision:
        if self.client is None or time.monotonic() < self._down_until:
            self.stats["heuristic"] += 1
            return self.heuristic(reel)
        user = (f"Creator: {reel.get('creator') or 'unknown'}\nCaption: {(reel.get('caption') or '')[:500]!r}\n"
                f"Saved so far: {progress.get('downloaded', 0)} of {progress.get('seen', 0)} seen.\n"
                f"Your last decisions: {', '.join(self.recent[-5:]) or 'none'}")
        try:
            out = self.client.chat_json(SYSTEM.format(interest=self.interest), user)
            action = "download" if str(out.get("action", "")).lower().startswith("down") else "skip"
            try:
                dwell = min(15.0, max(1.0, float(out.get("dwell_s", 0)))) or self._dwell()
            except (TypeError, ValueError):
                dwell = self._dwell()
            self.recent.append(action)
            self.stats["llm"] += 1
            return Decision(action, str(out.get("reason", ""))[:160], dwell, "llm")
        except LLMError as e:
            LOG.warning("LLM unavailable (%s); using keyword heuristic for %ds", e, self.retry_after_s)
            self._down_until = time.monotonic() + self.retry_after_s
            self.stats["heuristic"] += 1
            return self.heuristic(reel)


def build_client(cfg) -> LLMClient:
    """LLM client from config; for api='sarness' endpoint and token come from the Sarness Desktop install."""
    o = cfg["llm"]
    if o["api"] == "sarness":
        from .sarness import connection
        conn = connection(o)
        if conn is None:
            raise LLMError("no Sarness profile found (~/.config/sarness/profiles.json); set llm.endpoint")
        LOG.info("Sarness profile '%s' at %s (token: %s)", conn.profile_name, conn.base_url, conn.token_source)
        return LLMClient(conn.base_url, o["model"], o["timeout_s"], o["temperature"], "sarness", conn.token)
    key = os.environ.get(o.get("api_key_env") or "", "")
    if key:
        from .util import register_secret
        register_secret(key)
    return LLMClient(o["endpoint"], o["model"], o["timeout_s"], o["temperature"], o["api"], key)


def build_steering(cfg, force_heuristic: bool = False) -> Steering:
    o, c = cfg["llm"], cfg["collector"]
    client = None
    if not force_heuristic:
        try:
            client = build_client(cfg)
            LOG.info("LLM %s (%s) using model '%s'", client.endpoint, client.api, client.resolve_model())
        except LLMError as e:
            LOG.warning("LLM server not usable right now (%s). Using keyword heuristics; will retry later.", e)
    return Steering(o["interest"], client, c["explore_rate"], tuple(c["dwell_s"]))
