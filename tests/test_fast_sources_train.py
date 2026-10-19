"""Fast collection, download queue, interruption/resume, sources and training - against the local MOCK site."""
import random
import threading
import time

import pytest

from conftest import make_cfg
from vie.browser import BrowserSession
from vie.collector import Collector, StopFlags
from vie.download import DownloadResult, ytdlp_download
from vie.sessions import Session
from vie.steer import Steering
from vie.train import Trainer


@pytest.fixture(autouse=True)
def logged_in(monkeypatch):
    monkeypatch.setattr(BrowserSession, "logged_in", lambda self: True)


AUTHORS = {"AAAAA11111": "motion.studio", "BBBBB22222": "memes.daily", "CCCCC33333": "brand.films"}


def with_uploader(url, workdir, cookies, fmt, timeout, abort):
    """Real yt-dlp download, plus the uploader_id real Instagram supplies (the mock site has none)."""
    res = ytdlp_download(url, workdir, cookies, fmt, timeout, abort)
    if res.ok:
        res.info["channel"] = AUTHORS[url.rstrip("/").split("/")[-1]]   # real Instagram: channel = handle,
        res.info["uploader_id"] = "47847847345"                         # uploader_id = numeric id (never use as handle)
    return res


def collector(cfg, **kw):
    st = Steering("x", None, rng=random.Random(0))
    return Collector(cfg, st, BrowserSession(cfg, headless=True), **kw)


def test_fast_mode_queues_everything_without_filtering_and_downloads_all(tmp_path, mock_site):
    cfg = make_cfg(tmp_path, mock_site["base"], max_videos=3)
    s = collector(cfg).run()   # default mode = fast
    assert s.info["mode"] == "fast" and s.info["source"] == "reels" and s.info["status"] == "completed"
    got = {e["id"]: e for e in s.entries}
    assert set(got) == {"AAAAA11111", "BBBBB22222", "CCCCC33333"}
    # universal collector: even the "meme" reel is kept; no content classifier in fast mode
    assert all(e["status"] == "downloaded" and e["source"] == {"kind": "reels_feed"} for e in got.values())
    assert sorted(p.name for p in s.videos_dir.glob("0*.mp4")) == ["0001.mp4", "0002.mp4", "0003.mp4"]
    assert got["AAAAA11111"]["creator"] == "motion.studio" and got["AAAAA11111"]["probe"]["duration_s"] > 3


def test_downloads_do_not_block_browsing(tmp_path, mock_site):
    """Slow downloads: browsing must keep visiting reels while earlier downloads are still running."""
    starts, ends = [], []
    def slow(url, workdir, cookies, fmt, timeout, abort):
        starts.append(time.monotonic())
        time.sleep(5.0)
        ends.append(time.monotonic())
        return DownloadResult(False, error="simulated", kind="unavailable")
    cfg = make_cfg(tmp_path, mock_site["base"], download_workers=3, max_minutes=0.4)
    s = collector(cfg, downloader=slow).run()
    assert len(starts) == 3 and max(starts) - min(starts) < 4.5, "3 reels queued and started within one download time"
    assert min(ends) > max(starts), "all three were being fetched concurrently"
    assert {e["status"] for e in s.entries} == {"unavailable"}


def test_conservative_concurrency_is_respected(tmp_path, mock_site):
    running, peak, lock = 0, 0, threading.Lock()
    def d(url, workdir, cookies, fmt, timeout, abort):
        nonlocal running, peak
        with lock:
            running += 1; peak = max(peak, running)
        time.sleep(0.8)
        with lock:
            running -= 1
        return DownloadResult(False, error="x", kind="unavailable")
    cfg = make_cfg(tmp_path, mock_site["base"], download_workers=1, max_minutes=0.2)
    collector(cfg, downloader=d).run()
    assert peak == 1


def test_interrupt_finishes_queue_then_second_interrupt_leaves_rest_queued_and_resume_completes(tmp_path, mock_site):
    started = threading.Event()
    def slow(url, workdir, cookies, fmt, timeout, abort):
        started.set()
        for _ in range(60):  # 3 s unless aborted
            if abort.is_set():
                return DownloadResult(False, error="aborted by user", kind="aborted")
            time.sleep(0.05)
        return ytdlp_download(url, workdir, cookies, fmt, timeout, abort)
    cfg = make_cfg(tmp_path, mock_site["base"], download_workers=1, max_minutes=0.5)
    flags = StopFlags()
    c = collector(cfg, downloader=slow, flags=flags)
    def ctrl_c():
        started.wait(30)
        time.sleep(1.2)
        flags.stop.set()          # 1st Ctrl+C: stop browsing
        time.sleep(0.4)
        flags.abort.set()         # 2nd Ctrl+C: abort the active download
    threading.Thread(target=ctrl_c, daemon=True).start()
    s = c.run()
    assert s.info["status"] == "interrupted"
    st = {e["id"]: e["status"] for e in s.entries}
    assert "downloading" not in st.values()
    assert "queued" in st.values(), "aborted/unstarted downloads are persisted as queued, not lost"
    assert all(e["url"] for e in s.entries)
    assert not list(s.partial_dir.glob("*")) if s.partial_dir.exists() else True
    # resume finishes them inside the SAME session folder
    cfg2 = make_cfg(tmp_path, mock_site["base"])
    c2 = collector(cfg2)
    s2 = c2.run(resume=s.path)
    assert s2.path == s.path
    final = {e["id"]: e["status"] for e in Session(s.path).entries}
    assert set(final.values()) == {"downloaded"}, final
    assert len(list((s.path / "videos").glob("0*.mp4"))) == len(final)


def test_first_interrupt_alone_drains_queue(tmp_path, mock_site):
    cfg = make_cfg(tmp_path, mock_site["base"], download_workers=1)
    flags = StopFlags()
    def first_download_then_ctrl_c(url, workdir, cookies, fmt, timeout, abort):
        flags.stop.set()                            # a single Ctrl+C while a download is in flight
        return ytdlp_download(url, workdir, cookies, fmt, timeout, abort)
    s = collector(cfg, flags=flags, downloader=first_download_then_ctrl_c).run()
    assert s.info["status"] == "interrupted"
    assert all(e["status"] in ("downloaded", "duplicate") for e in s.entries), [e["status"] for e in s.entries]
    assert any(e["status"] == "downloaded" for e in s.entries)


def test_duplicates_across_sessions_in_fast_mode(tmp_path, mock_site):
    s1 = collector(make_cfg(tmp_path, mock_site["base"], max_videos=3)).run()
    s2 = collector(make_cfg(tmp_path, mock_site["base"], max_minutes=0.15)).run()
    assert s2.id != s1.id and not list(s2.videos_dir.glob("0*.mp4"))
    dups = [e for e in s2.entries if e["status"] == "duplicate"]
    assert dups and all(e["duplicate_of"]["session"] == s1.id for e in dups)


def test_saved_source_merges_collections_and_records_provenance(tmp_path, mock_site):
    cfg = make_cfg(tmp_path, mock_site["base"])
    s = collector(cfg, source="saved", downloader=with_uploader).run()
    assert s.info["source"] == "saved" and s.info["saved_collections"] == ["Motion", "All posts"]
    got = {e["id"]: e for e in s.entries}
    assert len(got) == 3 and all(e["status"] == "downloaded" for e in got.values())
    assert got["AAAAA11111"]["source"] == {"kind": "saved", "collection": "Motion", "collections": ["Motion", "All posts"]}
    assert got["BBBBB22222"]["source"]["collections"] == ["All posts"]
    assert got["AAAAA11111"]["url"].endswith("/reel/AAAAA11111/") and got["AAAAA11111"]["tile_type"] == "Clip"
    assert got["AAAAA11111"]["creator"] == "motion.studio" and got["AAAAA11111"]["creator_id"] == "47847847345"
    # creators represented in the references are written out for discovery
    import json
    cj = json.loads((s.path / "creators.json").read_text())
    assert {c["creator"] for c in cj["creators"]} >= {"motion.studio"}


def test_creator_source_derived_from_saved_and_explicit(tmp_path, mock_site):
    cfg = make_cfg(tmp_path, mock_site["base"])
    saved = collector(cfg, source="saved", downloader=with_uploader).run()
    # explicit list
    s = collector(make_cfg(tmp_path, mock_site["base"], dedupe_across_sessions=False), source="creators",
                  creators=["motion.studio"], downloader=with_uploader).run()
    e = s.entries[0]
    assert e["source"] == {"kind": "creator", "creator": "motion.studio"} and e["status"] == "downloaded"
    # derivation from earlier Saved sessions, most frequent first, never your own account
    c = collector(cfg, source="creators")
    assert set(c.discover_creators()) == {"motion.studio", "memes.daily", "brand.films"}


def test_inaccessible_creator_is_reported_not_bypassed(tmp_path, mock_site):
    cfg = make_cfg(tmp_path, mock_site["base"])
    s = collector(cfg, source="creators", creators=["does.not.exist"]).run()
    assert s.info["status"] == "completed" and s.entries == []


# ---------------------------------------------------------------------------------------------------
# Feed training: nothing happens without a keypress
# ---------------------------------------------------------------------------------------------------
class FakeLLM:
    def chat_json(self, system, user):
        return {"action": "save", "discipline": "motion graphics / kinetic typography", "reason": "test"}


def run_trainer(tmp_path, mock_site, answers, dry=False, n=1):
    cfg = make_cfg(tmp_path, mock_site["base"])
    b = BrowserSession(cfg, headless=True)
    b.start()
    try:
        b.open_feed()
        b.page.wait_for_timeout(1200)
        out = []
        it = iter(answers)
        t = Trainer(cfg, b, FakeLLM(), input_fn=lambda _="": next(it), out=out.append, dry_run=dry, max_reels=n)
        cfg.data["train"]["dwell_s"] = [0.1, 0.2]
        t.run_reels()
        state = b.page.evaluate("[...document.querySelectorAll('svg[aria-label]')].map(s=>s.getAttribute('aria-label'))")
        return t, out, state
    finally:
        b.close()


def test_training_skip_does_nothing_even_when_llm_suggests_save(tmp_path, mock_site):
    t, out, state = run_trainer(tmp_path, mock_site, [""])      # user just presses Enter
    assert t.log == [] and "Remove" not in state and "Unlike" not in state
    assert any("SAVE" in line for line in out), "suggestion is shown, never executed"


def test_training_approved_save_clicks_and_logs(tmp_path, mock_site):
    t, out, state = run_trainer(tmp_path, mock_site, ["y"])
    assert [a["action"] for a in t.log] == ["save"] and t.log[0]["result"] == "clicked"
    assert state.count("Remove") == 1 and "Unlike" not in state  # only the Save toggled, nothing else
    assert t.counts == {"motion graphics / kinetic typography": 1}


def test_training_dry_run_highlights_but_never_clicks(tmp_path, mock_site):
    t, out, state = run_trainer(tmp_path, mock_site, ["s"], dry=True)
    assert t.log[0]["result"].startswith("dry-run") and "Remove" not in state


def test_training_like_and_follow_need_their_own_keys(tmp_path, mock_site):
    t, out, state = run_trainer(tmp_path, mock_site, ["l"])
    assert [a["action"] for a in t.log] == ["like"] and state.count("Unlike") == 1 and "Remove" not in state
