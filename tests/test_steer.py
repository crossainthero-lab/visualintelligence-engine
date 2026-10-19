import json
import random
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from vie.steer import LLMClient, Steering


def fake_server(api, reply, require_token=None):
    seen = {}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def _send(self, code, obj):
            b = json.dumps(obj).encode()
            self.send_response(code); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def do_GET(self):
            seen["auth"] = self.headers.get("Authorization")
            if require_token and seen["auth"] != f"Bearer {require_token}":
                return self._send(401, {"detail": "invalid or missing API token"})
            if self.path == "/v1/models": self._send(200, {"data": [{"id": "m-a"}, {"id": "m-b"}]})
            elif self.path == "/api/tags": self._send(200, {"models": [{"name": "m-a"}]})
            else: self._send(404, {})
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            if self.path == "/v1/chat/completions": self._send(200, {"choices": [{"message": {"content": reply}}]})
            elif self.path == "/api/chat": self._send(200, {"message": {"content": reply}})
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}", seen


def test_openai_api_with_token_and_model_resolution():
    srv, url, seen = fake_server("openai", '<think>hmm</think>{"action":"download","dwell_s":5,"reason":"3d ad"}', "tok")
    c = LLMClient(url, api="openai", api_key="tok")
    assert c.resolve_model() == "m-a" and seen["auth"] == "Bearer tok"
    d = Steering("motion", c).decide({"creator": "x", "caption": "y"}, {})
    assert (d.action, d.source, d.dwell_s) == ("download", "llm", 5.0)
    srv.shutdown()


def test_missing_token_is_reported():
    srv, url, _ = fake_server("openai", "{}", "tok")
    try:
        LLMClient(url, api="openai").models()
        assert False
    except Exception as e:
        assert "401" in str(e) and "api_key_env" in str(e)
    srv.shutdown()


def test_ollama_api_and_unknown_model():
    srv, url, _ = fake_server("ollama", '{"action":"skip","reason":"meme"}')
    c = LLMClient(url, "nope", api="ollama")
    try:
        c.resolve_model(); assert False
    except Exception as e:
        assert "available: m-a" in str(e)
    c.model = "m-a"
    assert Steering("x", c).decide({}, {}).action == "skip"
    srv.shutdown()


def test_disconnected_server_falls_back_to_heuristic_then_retries():
    c = LLMClient("http://127.0.0.1:9", "m", timeout=1)
    st = Steering("x", c, rng=random.Random(1), retry_after_s=3600)
    d = st.decide({"creator": "a", "caption": "After Effects motion design breakdown"}, {})
    assert d.action == "download" and d.source == "heuristic"
    assert st.decide({"caption": "funny meme"}, {}).action == "skip"
    assert st._down_until > 0  # circuit breaker engaged: no hammering the dead server


def test_garbage_model_output_falls_back():
    srv, url, _ = fake_server("openai", "I think you should download it!")
    c = LLMClient(url, "m-a")
    assert Steering("x", c).decide({"caption": "3d render"}, {}).source == "heuristic"
    srv.shutdown()
