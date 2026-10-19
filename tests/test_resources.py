import json
import multiprocessing as mp
import os
import subprocess
import sys
import time

import pytest

from vie import resources as R
from vie.sessions import recover_stale_sessions


def _hold(path, ready, release):
    lk = R.InstanceLock(path)
    lk.acquire()
    ready.set()
    release.wait(20)
    lk.release()


def test_instance_lock_blocks_second_collector_and_frees_on_exit(tmp_path):
    ctx = mp.get_context("fork")
    ready, release = ctx.Event(), ctx.Event()
    p = ctx.Process(target=_hold, args=(tmp_path, ready, release))
    p.start()
    assert ready.wait(10)
    with pytest.raises(R.AlreadyRunning):
        R.InstanceLock(tmp_path).acquire()
    p.kill()  # SIGKILL: the kernel must release the flock, nothing can go stale
    p.join()
    lk = R.InstanceLock(tmp_path)
    lk.acquire()
    lk.release()


def test_evaluate_thresholds_and_unknowns():
    lim = R.LIMIT_DEFAULTS
    assert R.evaluate(R.Sample(), lim).action == "ok"  # unknown readings never trigger anything
    assert R.evaluate(R.Sample(mem_available_mb=2000), lim).action == "pause"
    assert R.evaluate(R.Sample(mem_available_mb=900), lim).action == "stop"
    assert R.evaluate(R.Sample(disk_free_gb=1.0), lim).action == "stop"
    assert R.evaluate(R.Sample(owned_gpu_mb=2000), lim).action == "recycle"
    assert R.evaluate(R.Sample(gpu_used_pct=95), lim).action == "pause"
    v = R.evaluate(R.Sample(gpu_kernel_errors=2), lim)
    assert v.action == "stop" and "NVIDIA" in v.reasons[0]
    assert R.evaluate(R.Sample(gpu_kernel_errors=2), {**lim, "stop_on_gpu_driver_errors": False}).action == "ok"
    s = R.Sample(mem_available_mb=900, owned_gpu_mb=2000)
    assert R.evaluate(s, lim).action == "stop"  # most severe wins


def test_browser_pids_only_match_our_private_profile(tmp_path):
    prof = tmp_path / "my-profile"
    other = tmp_path / "other-profile"
    ours = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", f"--user-data-dir={prof}"])
    theirs = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", f"--user-data-dir={other}"])
    try:
        time.sleep(0.3)
        assert R.browser_pids(prof) == [ours.pid]
        assert R.reap_orphan_browsers(prof) == 1
        ours.wait(timeout=10)
        assert theirs.poll() is None, "an unrelated process must never be touched"
    finally:
        theirs.kill()
        ours.kill()


def test_guard_samples_and_waits(tmp_path):
    g = R.ResourceGuard({"check_every_s": 1}, tmp_path / "p", tmp_path)
    v = g.sample_once()
    assert v.action in ("ok", "pause", "recycle", "stop")
    assert g.samples == 1 and g.last.mem_available_mb
    import threading
    g.verdict = R.Verdict("recycle", ["x"])
    assert g.wait_if_paused(threading.Event()) == "recycle"
    g.verdict = R.Verdict("ok")
    assert g.wait_if_paused(threading.Event()) == "ok"


def test_recover_stale_sessions_only_touches_status(tmp_path):
    d = tmp_path / "2026-01-01_0101"
    (d / "videos").mkdir(parents=True)
    (d / "videos" / "0001.mp4").write_bytes(b"x")
    (d / "session.json").write_text(json.dumps({"status": "running", "pid": 999999, "started_at": "x"}))
    (d / "metadata.json").write_text(json.dumps({"videos": [{"id": "a", "status": "downloading"}, {"id": "b", "status": "downloaded"}]}))
    live = tmp_path / "2026-01-01_0102"
    live.mkdir()
    (live / "session.json").write_text(json.dumps({"status": "running", "pid": os.getpid()}))
    fixed = recover_stale_sessions(tmp_path)
    assert fixed == ["2026-01-01_0101"] or fixed == ["2026-01-01_0101", "2026-01-01_0102"]
    info = json.loads((d / "session.json").read_text())
    assert info["status"] == "interrupted" and info["recovered"] is True
    st = {e["id"]: e["status"] for e in json.loads((d / "metadata.json").read_text())["videos"]}
    assert st == {"a": "queued", "b": "downloaded"}
    assert (d / "videos" / "0001.mp4").read_bytes() == b"x"


def test_fast_mode_never_builds_an_llm_client(monkeypatch):
    from vie import steer
    from vie.config import load_config

    def boom(*a, **k):
        raise AssertionError("fast mode must not touch the LLM")
    monkeypatch.setattr(steer, "build_client", boom)
    st = steer.build_steering(load_config(env={}), force_heuristic=True)
    assert st.client is None if hasattr(st, "client") else True


def test_chromium_args_software_by_default():
    from vie.browser import BrowserSession
    from vie.config import load_config
    args = BrowserSession(load_config(env={})).chromium_args()
    assert "--disable-gpu" in args and "--disable-accelerated-video-decode" in args and "--mute-audio" in args
    cfg = load_config(env={})
    cfg["browser"]["gpu"] = "auto"
    assert "--disable-gpu" not in BrowserSession(cfg).chromium_args()
