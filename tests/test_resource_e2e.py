"""Resource-safety behaviour against the local mock site: real Chromium, real yt-dlp, real process trees."""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from conftest import ROOT, make_cfg
from test_collector_e2e import run_collector, seed_login
from vie import resources as R
from vie.browser import BrowserSession
from vie.collector import Collector
from vie.steer import Steering


def fast(cfg, **kw):
    cfg.data["collector"]["mode"] = "fast"
    for k, v in kw.items():
        sec, key = k.split("__")
        cfg.data[sec][key] = v
    return cfg


def test_browser_recycles_and_leaves_no_processes_behind(tmp_path, mock_site):
    seed_login(None)
    cfg = fast(make_cfg(tmp_path, mock_site["base"], max_minutes=0.5), browser__recycle_after_reels=2)
    s = run_collector(cfg, mode="fast")
    assert s.info["status"] == "completed", s.info
    assert s.info["resources"]["browser_recycles"] >= 1
    assert any(e["status"] == "downloaded" for e in s.entries)
    assert R.browser_pids(cfg.state_dir / "browser-profile") == [], "browser processes must not outlive the collector"


def test_pressure_stop_saves_everything_and_resume_finishes(tmp_path, mock_site):
    seed_login(None)
    # an impossible RAM threshold simulates pressure: the collector must stop SAFELY, not crash or lose data
    cfg = fast(make_cfg(tmp_path, mock_site["base"], max_minutes=2), limits__stop_mem_available_mb=10 ** 9, limits__check_every_s=1)
    s = run_collector(cfg, mode="fast")
    assert s.info["status"] == "interrupted"
    assert "resource pressure" in s.info["stop_reason"] and "available RAM" in s.info["stop_reason"]
    meta = json.loads((s.path / "metadata.json").read_text())
    assert all(e["status"] in ("downloaded", "queued", "duplicate") for e in meta["videos"])
    assert R.browser_pids(cfg.state_dir / "browser-profile") == []


def test_guard_pauses_then_continues_when_pressure_clears(tmp_path):
    import threading
    g = R.ResourceGuard({"check_every_s": 1, "max_pause_s": 30}, tmp_path / "p", tmp_path)
    g.verdict = R.Verdict("pause", ["test"])
    ev = threading.Event()
    threading.Timer(1.0, lambda: setattr(g, "verdict", R.Verdict("ok"))).start()
    t0 = time.monotonic()
    assert g.wait_if_paused(ev) == "ok"
    assert 0.8 < time.monotonic() - t0 < 6


def test_second_collector_is_refused_while_first_runs(tmp_path):
    state = tmp_path / "state"
    holder = subprocess.Popen([sys.executable, "-c", f"""
import sys,time; sys.path.insert(0,{str(ROOT)!r})
from vie.resources import InstanceLock
from pathlib import Path
l=InstanceLock(Path({str(state)!r})); l.acquire(); print('held',flush=True); time.sleep(30)"""], stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "held"
        env = {**os.environ, "VIE_STATE_DIR": str(state), "VIE_SESSIONS_DIR": str(tmp_path / "s")}
        r = subprocess.run([sys.executable, "-m", "vie.collect_cli", "--headless", "--minutes", "0.1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
        assert r.returncode == 3 and "already running" in r.stderr
        assert not (tmp_path / "s").exists(), "a refused start must not create a session folder"
    finally:
        holder.kill()


def test_sigkill_then_restart_recovers_and_cleans_orphans(tmp_path, mock_site):
    """Hard kill (what a freeze looks like to the next run): stale session recovered, orphan Chromium reaped."""
    cfg = make_cfg(tmp_path, mock_site["base"], max_minutes=3)
    env = {**os.environ, "VIE_STATE_DIR": str(cfg.state_dir), "VIE_SESSIONS_DIR": str(cfg.sessions_dir), "VIE_CONFIG": str(tmp_path / "c.toml")}
    (tmp_path / "c.toml").write_text(f'[instagram]\nbase_url = "{mock_site["base"]}"\nstart_url = "{mock_site["base"]}/reels.html"\n[browser]\nheadless = true\n[collector]\nmode = "fast"\nfast_dwell_s = [0.2, 0.3]\n')
    code = ("from conftest import *; from vie.browser import BrowserSession; BrowserSession.logged_in = lambda self: True; "
            "from vie.collect_cli import main; main(['--mode','fast','--headless','--minutes','3'])")
    p = subprocess.Popen([sys.executable, "-c", code], cwd=ROOT / "tests", env={**env, "PYTHONPATH": str(ROOT)}, stderr=subprocess.PIPE, text=True)
    prof = cfg.state_dir / "browser-profile"
    deadline = time.time() + 40
    while time.time() < deadline and not (R.browser_pids(prof) and list(cfg.sessions_dir.glob("*/videos/0001.mp4"))):
        time.sleep(0.5)
    assert R.browser_pids(prof), "browser should be running"
    p.send_signal(signal.SIGKILL)
    p.wait()
    assert R.browser_pids(prof), "SIGKILL leaves Chromium orphaned (this is the failure we must recover from)"
    sess = next(cfg.sessions_dir.iterdir())
    assert json.loads((sess / "session.json").read_text())["status"] == "running"
    # next normal run: lock is free (kernel released it), orphans reaped, stale session recovered
    cfg2 = make_cfg(tmp_path, mock_site["base"], max_minutes=0.05)
    seed_login(None)
    run_collector(cfg2, mode="fast")
    assert json.loads((sess / "session.json").read_text())["status"] == "interrupted"
    assert json.loads((sess / "session.json").read_text())["recovered"] is True
    assert R.browser_pids(prof) == []
