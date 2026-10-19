"""End-to-end against a LOCAL MOCK site (not Instagram): real Chromium, real yt-dlp, real ffprobe."""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from conftest import ROOT, make_cfg
from vie.browser import BrowserSession
from vie.collector import Collector
from vie.sessions import Session
from vie.steer import Steering
import random


def run_collector(cfg, mode="normal", **kw):
    st = Steering("motion", None, explore_rate=0, dwell=(0.1, 0.2), rng=random.Random(0))
    return Collector(cfg, st, BrowserSession(cfg, headless=True), mode=mode, **kw).run()


def seed_login(cfg):
    """The mock needs no login; pretend a saved sessionid exists so ensure_login passes."""
    BrowserSession.logged_in = lambda self: True


def test_full_collection_and_dedupe(tmp_path, mock_site):
    seed_login(None)
    cfg = make_cfg(tmp_path, mock_site["base"], max_videos=2)
    s = run_collector(cfg)
    assert s.info["status"] == "completed", s.info
    got = {e["id"]: e for e in s.entries}
    # AAAAA (motion keywords) and CCCCC (commercial/cinematic) kept; BBBBB (meme) skipped
    assert got["AAAAA11111"]["status"] == "downloaded" and got["CCCCC33333"]["status"] == "downloaded"
    assert got["BBBBB22222"]["status"] == "skipped"
    e = got["AAAAA11111"]
    assert e["file"] == "videos/0001.mp4" and (s.path / e["file"]).stat().st_size == e["bytes"]
    assert e["creator"] == "motion.studio" and "Kinetic" in e["caption"] and e["url"].endswith("/reel/AAAAA11111/")
    assert e["probe"]["duration_s"] > 3 and e["sha256"] and e["agent_decision"]["source"] == "heuristic"
    assert not os.access(s.path / e["file"], os.W_OK)
    assert (s.path / "collector.log").stat().st_size > 0
    # second session: same reels are duplicates, original files untouched
    first_hash = e["sha256"]
    cfg2 = make_cfg(tmp_path, mock_site["base"], max_videos=0, max_minutes=0.15)
    s2 = run_collector(cfg2)
    assert s2.id != s.id
    assert not list(s2.videos_dir.glob("0*.mp4"))
    assert {x["status"] for x in s2.entries if x["id"].startswith(("AAAAA", "CCCCC"))} == {"duplicate"}
    assert Session(s.path).get("AAAAA11111")["sha256"] == first_hash


def test_failed_download_retried_then_recorded(tmp_path, mock_site):
    seed_login(None)
    from vie.download import DownloadResult
    calls = []
    def flaky(url, workdir, cookies, fmt, timeout, abort):
        calls.append(url)
        return DownloadResult(False, error="HTTP Error 503", kind="transient")
    cfg = make_cfg(tmp_path, mock_site["base"], max_videos=1, download_retries=3, max_consecutive_failures=2)
    s = run_collector(cfg, downloader=flaky)
    bad = [e for e in s.entries if e["status"] == "failed"]
    assert bad and bad[0]["attempts"] >= 3 and bad[0]["error"] == "HTTP Error 503" and bad[0]["url"]
    assert s.info["status"] == "completed" and "consecutive" in s.info["stop_reason"]


def test_unavailable_not_retried_url_kept(tmp_path, mock_site):
    seed_login(None)
    from vie.download import DownloadResult
    calls = []
    def private(url, *a):
        calls.append(url); return DownloadResult(False, error="login required", kind="unavailable")
    cfg = make_cfg(tmp_path, mock_site["base"], max_minutes=0.1)
    s = run_collector(cfg, downloader=private)
    assert len(calls) == len(set(calls))  # one attempt per reel
    assert all(e["status"] in ("unavailable", "skipped") for e in s.entries)
    assert any(e["status"] == "unavailable" and e["url"] for e in s.entries)


def test_ctrl_c_keeps_files_and_metadata(tmp_path, mock_site):
    """Real process, real SIGINT to the whole process group (like a terminal Ctrl+C)."""
    cfg_path = tmp_path / "cfg.toml"
    cfg_path.write_text(f'''[paths]
sessions_dir = "{tmp_path}/ss"
state_dir = "{tmp_path}/state"
[instagram]
base_url = "{mock_site["base"]}"
start_url = "{mock_site["base"]}/reels.html"
[collector]
dwell_s = [0.2, 0.3]
''')
    code = ("import sys; sys.path.insert(0,%r); from vie.browser import BrowserSession; "
            "BrowserSession.logged_in=lambda s: True; from vie.collect_cli import main; "
            "sys.exit(main(['--config',%r,'--headless','--no-llm']))" % (str(ROOT), str(cfg_path)))
    p = subprocess.Popen([sys.executable, "-c", code], start_new_session=True, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True)
    ss = tmp_path / "ss"
    deadline = time.time() + 90
    while time.time() < deadline:
        vids = list(ss.glob("*/videos/0001.mp4"))
        if vids and (vids[0].parent.parent / "metadata.json").exists():
            break
        time.sleep(0.5)
    else:
        os.killpg(p.pid, signal.SIGKILL); pytest.fail("no download within 90s:\n" + p.stdout.read())
    os.killpg(p.pid, signal.SIGINT)
    out, _ = p.communicate(timeout=60)
    assert p.returncode == 0, out
    sess = next(ss.iterdir())
    info = json.loads((sess / "session.json").read_text())
    meta = json.loads((sess / "metadata.json").read_text())
    assert info["status"] == "interrupted" and info["ended_at"]
    done = [e for e in meta["videos"] if e["status"] == "downloaded"]
    assert done and all((sess / e["file"]).is_file() for e in done)
    assert not any(e["status"] == "downloading" for e in meta["videos"]), "no half-finished entries"
    assert not list((sess / "videos").glob(".partial/*")), "scratch cleaned"
