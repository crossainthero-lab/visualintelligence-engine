"""The collection loop. Collects and organises references only: no video analysis happens here."""
from __future__ import annotations

import os
import queue
import random
import re
import signal
import threading
import time
from collections import Counter
from pathlib import Path

from .browser import BrowserSession, ChallengeDetected
from . import download as _download_mod
from .download import DownloadResult, clean_dir, ytdlp_download
from .resources import ResourceGuard, reap_orphan_browsers
from .sessions import Session, known_videos, now_iso, recover_stale_sessions, session_dirs
from .steer import Steering
from .util import LOG, read_json, setup_logging, write_json


class StopFlags:
    """First Ctrl+C: finish current download and stop. Second: abort the download. Third: hard exit."""

    def __init__(self):
        self.stop = threading.Event()
        self.abort = threading.Event()
        self.presses = 0
        self.finalising = False

    def handler(self, signum, frame):
        self.presses += 1
        if self.presses == 1:
            LOG.warning("Stopping after the current step (Ctrl+C again to abort the active download)...")
            self.stop.set()
        elif self.presses == 2:
            LOG.warning("Aborting active download...")
            self.abort.set()
        else:
            self.abort.set()
            if not self.finalising:  # while persisting state, never raise: it must always complete
                raise KeyboardInterrupt


class DownloadPool:
    """Background download workers. Browsing never waits for them; nothing queued is ever silently dropped:
    on abort, unstarted entries simply stay 'queued' in metadata.json (resume with ./collect.sh --resume)."""

    def __init__(self, collector: "Collector", workers: int):
        self.col = collector
        self.q: queue.Queue = queue.Queue()
        self.n = max(1, min(workers, collector.c.get("max_download_workers", 4)))  # hard cap: bounded parallelism
        self.threads: list[threading.Thread] = []
        self.closing = False
        self.active = 0
        self._lock = threading.Lock()

    def start(self) -> None:
        for i in range(self.n):
            t = threading.Thread(target=self._work, name=f"dl-{i + 1}", daemon=True)
            t.start()
            self.threads.append(t)

    def submit(self, entry: dict) -> None:
        self.q.put(entry)

    def depth(self) -> int:
        return self.q.qsize() + self.active

    def _work(self) -> None:
        while True:
            try:
                entry = self.q.get(timeout=0.4)
            except queue.Empty:
                if self.closing:
                    return
                continue
            if self.col.flags.abort.is_set():
                continue  # leave as 'queued': persisted, resumable
            with self._lock:
                self.active += 1
            try:
                self.col._download(entry, use_browser=False)
            except Exception as e:  # noqa: BLE001 - a worker must never die
                LOG.exception("[%s] worker error: %s", entry.get("id"), e)
                self.col.session.update(entry, status="failed", error=f"worker error: {e}")
            finally:
                with self._lock:
                    self.active -= 1

    def close(self) -> None:
        """Finish everything queued (first Ctrl+C) or leave the rest queued (abort), then stop the workers."""
        self.closing = True
        last = 0.0
        while any(t.is_alive() for t in self.threads):
            for t in self.threads:
                t.join(0.5)
            if time.monotonic() - last > self.col.c["progress_every_s"]:
                last = time.monotonic()
                self.col.progress("draining downloads")


class Collector:
    def __init__(self, cfg, steering: Steering, browser: BrowserSession | None = None, flags: StopFlags | None = None,
                 downloader=ytdlp_download, mode: str | None = None, source: str = "reels",
                 creators: list[str] | None = None, limit: int | None = None):
        self.cfg = cfg
        self.steer = steering
        self.browser = browser or BrowserSession(cfg)
        self.flags = flags or StopFlags()
        self.downloader = downloader
        self.c = cfg["collector"]
        self.session: Session | None = None
        self.known: dict = {}
        self.seen: set[str] = set()
        self.consecutive_failures = 0
        self.stop_reason = "completed"
        self.mode = mode or self.c.get("mode", "fast")
        self.source = source
        self.creators = creators or []
        self.limit = limit
        self.pool: DownloadPool | None = None
        self._lock = threading.Lock()
        self._last_cookie = 0.0
        self._last_progress = 0.0
        self._t_start = time.monotonic()
        self.resume_path: Path | None = None
        self.guard: ResourceGuard | None = None
        self._reels_since_recycle = 0
        self._browser_started = time.monotonic()
        self.recycles = 0

    # ---- entry point ---------------------------------------------------------------------------
    def run(self, resume: Path | None = None) -> Session:
        if resume:
            s = self.session = Session(resume)
            self.resume_path = resume
            s.info.setdefault("resumes", []).append({"at": now_iso(), "pid": os.getpid()})
            s.info.update(status="running", pid=os.getpid(), ended_at=None)
            s.save()
            setup_logging(s.path / "collector.log")
            LOG.info("Resuming Scroll Session %s", s.id)
        else:
            s = self.session = Session.create(self.cfg.sessions_dir, self.cfg.public_snapshot())
            setup_logging(s.path / "collector.log")
            LOG.info("Scroll Session %s -> %s", s.id, s.path)
            s.info.update(instagram_account=self.cfg["instagram"]["account"], mode=self.mode, source=self.source)
            s.save()
        self.known = known_videos(self.cfg.sessions_dir) if self.c["dedupe_across_sessions"] else {}
        LOG.info("mode=%s source=%s | %d videos already collected earlier (de-duplication)", self.mode, self.source,
                 len(self.known))
        _download_mod.NICE = int(self.c.get("download_nice", 10))
        recovered = recover_stale_sessions(self.cfg.sessions_dir, skip=s.id)
        if recovered:
            LOG.warning("Recovered %d session(s) whose collector died earlier (crash/kill/freeze): %s. Their queued "
                        "downloads can be finished with ./collect.sh --resume <session>.", len(recovered), ", ".join(recovered))
        reap_orphan_browsers(self.browser.profile)  # we hold the instance lock: leftovers are not anyone's live browser
        self.guard = ResourceGuard(self.cfg["limits"], self.browser.profile, self.cfg.sessions_dir,
                                   history_path=s.path / "resources.jsonl")
        self.guard.start()
        old = signal.signal(signal.SIGINT, self.flags.handler)
        old_term = signal.signal(signal.SIGTERM, self.flags.handler)
        old_hup = signal.signal(signal.SIGHUP, self.flags.handler)
        status = "completed"
        try:
            self._run_with_restarts()
            if self.flags.stop.is_set() and self.stop_reason == "completed":
                status, self.stop_reason = "interrupted", "user stop (Ctrl+C)"
            elif self.stop_reason.startswith("resource pressure"):
                status = "interrupted"
        except KeyboardInterrupt:
            status, self.stop_reason = "interrupted", "hard stop"
        except Exception as e:  # noqa: BLE001 - always finalise the session
            LOG.exception("collector crashed: %s", e)
            status, self.stop_reason = "error", f"{type(e).__name__}: {e}"
        finally:
            try:  # keep our handler installed: a further Ctrl+C must never abort the persistence below
                self._finalise(status)
            finally:
                signal.signal(signal.SIGINT, old)
                signal.signal(signal.SIGTERM, old_term)
                signal.signal(signal.SIGHUP, old_hup)
        return s

    def _finalise(self, status: str) -> None:
        s = self.session
        self.flags.finalising = True
        if self.pool:  # browsing is over: finish queued downloads (or leave them queued if aborted)
            if self.flags.stop.is_set() and not self.flags.abort.is_set() and self.pool.depth():
                LOG.info("Finishing %d queued downloads (Ctrl+C again to abort; the rest stays queued)", self.pool.depth())
            while True:
                try:
                    self.pool.close()
                    break
                except KeyboardInterrupt:  # impatient 3rd Ctrl+C: abort active downloads, still persist everything
                    self.flags.abort.set()
        left = [e for e in s.entries if e["status"] in ("downloading", "queued")]
        for e in left:  # anything not finished is persisted as resumable, never lost
            s.update(e, status="queued")
        if status != "interrupted" or not self.flags.abort.is_set():
            self._retry_failed()
        clean_dir(s.partial_dir)
        self.browser.close()
        try:
            self.browser.cookie_file.unlink(missing_ok=True)
        except Exception:
            pass
        self._write_creators()
        if self.guard:
            self.guard.stop()
            s.info["resources"] = {**self.guard.summary(), "browser_recycles": self.recycles}
        s.finish(status, self.stop_reason)
        self.progress("final", force=True)
        if left:
            LOG.warning("%d reels stay queued (URLs saved). Finish them with: ./collect.sh --resume %s", len(left), s.id)
        LOG.info("Analyse later with: ./analyse.sh")

    # ---- progress ----------------------------------------------------------------------------------------
    def progress(self, label: str = "progress", force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_progress < self.c["progress_every_s"]:
            return
        self._last_progress = now
        c = self.session.counts()
        mins = max((now - self._t_start) / 60, 1e-9)
        LOG.info("%s: visited %d (%.1f/min) | queued %d | downloading %d | downloaded %d | duplicates %d | failed %d | "
                 "unavailable %d", label, len(self.seen), len(self.seen) / mins, c.get("queued", 0),
                 c.get("downloading", 0), c.get("downloaded", 0), c.get("duplicate", 0), c.get("failed", 0),
                 c.get("unavailable", 0))

    # ---- cookies (workers read a file the browser thread keeps fresh) -------------------------------------
    def _refresh_cookies(self, force: bool = False) -> None:
        if force or time.monotonic() - self._last_cookie > self.c["cookie_refresh_s"]:
            try:
                self.browser.export_cookies()
                self._last_cookie = time.monotonic()
            except Exception as e:  # noqa: BLE001
                LOG.debug("cookie refresh skipped: %s", e)

    # ---- browser lifecycle ------------------------------------------------------------------------------
    def _run_with_restarts(self) -> None:
        restarts = 0
        max_restarts = self.cfg["browser"]["max_restarts"]
        self._t_start = time.monotonic()
        self.t0 = self._t_start
        while not self._should_stop():
            try:
                self.browser.start()
                self._browser_started, self._reels_since_recycle = time.monotonic(), 0
                self.browser.ensure_login(self.flags.stop)
                if self.flags.stop.is_set():
                    return
                self._refresh_cookies(force=True)
                if self.mode != "normal" and self.pool is None:
                    self.pool = DownloadPool(self, self.c["download_workers"])
                    self.pool.start()
                if self.resume_path:
                    self._resume_queued()
                elif self.source == "reels":
                    self.browser.open_feed()
                    self._loop() if self.mode == "normal" else self._fast_loop()
                else:
                    self._grid_sources()
                return
            except Exception as e:  # browser crash/closed window/navigation failure
                if self.flags.stop.is_set():
                    return
                restarts += 1
                LOG.error("Browser problem (%s). Restart %d/%d", str(e).splitlines()[0][:200], restarts, max_restarts)
                self.browser.close()
                if restarts > max_restarts:
                    raise
                self.flags.stop.wait(3 * restarts)

    def _should_stop(self) -> bool:
        if self.flags.stop.is_set():
            return True
        mv, mm = self.c["max_videos"], self.c["max_minutes"]
        if mv and self.session.counts().get("downloaded", 0) >= mv:
            self.stop_reason = f"reached max_videos={mv}"
            return True
        if mm and time.monotonic() - self.t0 >= mm * 60:
            self.stop_reason = f"reached max_minutes={mm}"
            return True
        if self.consecutive_failures >= self.c["max_consecutive_failures"]:
            self.stop_reason = f"{self.consecutive_failures} consecutive download failures"
            return True
        return False

    # ---- shared feed plumbing --------------------------------------------------------------------------
    def _next_reel(self, state: dict) -> dict | None:
        """Current reel from the feed, or None when we should just try again / have scrolled on."""
        if self.browser.challenge_active():
            if not self.browser.wait_for_human(self.flags.stop):
                self.stop_reason = "challenge not resolved"
                self.flags.stop.set()
                return None
            self.browser.open_feed()
        reel = self.browser.current_reel()
        if reel is None:
            state["empty"] += 1
            if state["empty"] % 6 == 0:
                LOG.warning("No reel visible; reloading feed")
                self.browser.open_feed()
            else:
                self.browser.dismiss_popups()
                self.flags.stop.wait(1.5)
            return None
        state["empty"] = 0
        if reel["shortcode"] in self.seen:
            state["stuck"] += 1
            if state["stuck"] > 4:
                LOG.warning("Feed not advancing; reloading")
                self.browser.open_feed()
                state["stuck"] = 0
            else:
                self.browser.next_reel()
            return None
        state["stuck"] = 0
        self.seen.add(reel["shortcode"])
        return reel

    def _housekeeping(self) -> bool:
        """Between reels: tab limit, resource pressure, scheduled browser recycle. False => stop browsing."""
        self.browser.enforce_tab_limit()
        reason = None
        if self.guard:
            act = self.guard.wait_if_paused(self.flags.stop)
            if act == "stop":
                self.stop_reason = "resource pressure: " + "; ".join(self.guard.verdict.reasons or ["paused too long"])
                LOG.error("Stopping safely: %s", self.stop_reason)
                self.flags.stop.set()
                return False
            if act == "recycle":
                reason = "; ".join(self.guard.verdict.reasons)
        b = self.cfg["browser"]
        if reason is None and b.get("recycle_after_reels") and self._reels_since_recycle >= b["recycle_after_reels"]:
            reason = f"{self._reels_since_recycle} reels since last restart"
        if reason is None and b.get("recycle_after_min") and \
                time.monotonic() - self._browser_started > b["recycle_after_min"] * 60:
            reason = f"{b['recycle_after_min']} min since last restart"
        if reason:
            self._recycle_browser(reason)
        return not self.flags.stop.is_set()

    def _recycle_browser(self, why: str) -> None:
        """Restart OUR Chromium (login persists in the profile) to release decoder/GPU/renderer memory."""
        LOG.info("Restarting the collector browser (%s)", why)
        self.browser.close()
        self.recycles += 1
        self.flags.stop.wait(1.0)
        self.browser.start()
        self._browser_started, self._reels_since_recycle = time.monotonic(), 0
        self.browser.ensure_login(self.flags.stop)
        self._refresh_cookies(force=True)
        self.browser.open_feed()
        if self.guard:
            self.guard.verdict.action = "ok"  # re-measured within check_every_s

    def _scroll_on(self) -> None:
        before = self.browser.current_path()
        self.browser.next_reel()
        if not re.match(r"^/(?:[\w.]+/)?reels?/[\w-]{5,}", before):
            return  # URL does not encode the active reel here, so there is nothing to wait for
        for _ in range(8):  # real Instagram updates the URL once the next reel is active
            if self.browser.current_path() != before or self.flags.stop.is_set():
                break
            self.flags.stop.wait(0.5)

    # ---- FAST mode: glance 5-7 s, queue the full download, move on ----------------------------------------
    def _fast_loop(self) -> None:
        state = {"empty": 0, "stuck": 0}
        lo, hi = self.c["fast_dwell_s"]
        while not self._should_stop():
            while self.pool.depth() >= self.c["queue_max"] and not self.flags.stop.is_set():
                LOG.info("Download queue full (%d); browsing waits", self.pool.depth())
                self.flags.stop.wait(2)
            if not self._housekeeping():
                break
            reel = self._next_reel(state)
            if reel is None:
                continue
            self._reels_since_recycle += 1
            self._queue_reel(reel, {"kind": "reels_feed"})
            self._refresh_cookies()
            self.flags.stop.wait(random.uniform(lo, hi))  # a short look; the analysis agent watches it later
            self.progress()
            if not self._should_stop():
                self._scroll_on()

    def _queue_reel(self, reel: dict, source: dict) -> dict | None:
        """Record a reel immediately (URL, id, creator, caption) and queue its full download."""
        s, code = self.session, reel["shortcode"]
        with self._lock:
            ex = s.get(code)
            if ex is not None:  # e.g. one reel in two Saved collections: merge the provenance
                cols = ex.setdefault("source", {}).setdefault("collections", [])
                name = source.get("collection")
                if name and name not in cols:
                    s.update(ex, source={**ex["source"], "collections": cols + [name]})
                return None
        entry = s.add({"id": code, "url": reel["url"], "creator": reel.get("creator") or source.get("creator"),
                       "caption": reel.get("caption") or None, "caption_source": "feed" if reel.get("caption") else None,
                       "duration_hint_s": reel.get("duration"), "source": dict(source, collections=(
                           [source["collection"]] if source.get("collection") else []))
                       if source.get("kind") == "saved" else dict(source),
                       "tile_type": reel.get("tile_type")})
        if code in self.known:
            k = self.known[code]
            s.update(entry, status="duplicate", duplicate_of={"session": k["session"], "file": k["file"]})
            LOG.info("[%s] duplicate of %s/%s", code, k["session"], k["file"])
            return None
        s.update(entry, status="queued")
        self.pool.submit(entry)
        LOG.info("[%s] @%s queued (%s)", code, entry.get("creator"), source.get("kind"))
        return entry

    # ---- GRID sources: Saved / collections / creator profiles -----------------------------------------------
    def _grid_sources(self) -> None:
        base = self.cfg["instagram"]["base_url"].rstrip("/")
        account = self.cfg["instagram"]["account"]
        if self.source == "saved":
            cols = self.browser.saved_collections(account)
            named = [c for c in cols if not c["default"]] + [c for c in cols if c["default"]]
            if not named:
                named = [{"name": "All posts", "url": f"{base}/{account}/saved/all-posts/", "default": True}]
            LOG.info("Saved collections found: %s", ", ".join(c["name"] for c in named))
            self.session.info["saved_collections"] = [c["name"] for c in named]
            for c in named:
                if self._should_stop():
                    return
                tiles = self.browser.grid_collect(c["url"], self.flags.stop, limit=self.limit or 0,
                                                  pause=self.c["grid_scroll_pause_s"])
                if tiles is None:
                    LOG.warning("Collection '%s' not accessible from desktop Instagram", c["name"])
                    continue
                LOG.info("Collection '%s': %d saved items", c["name"], len(tiles))
                for t in tiles:
                    if self._should_stop():
                        break
                    self.seen.add(t["shortcode"])
                    self._queue_reel(t, {"kind": "saved", "collection": c["name"]})
                    self._wait_for_queue_room()
                    self.progress()
        else:  # creators
            handles = self.creators or self.discover_creators()
            if not handles:
                LOG.warning("No creators to browse: collect --source saved first, or pass --creators a,b,c")
                return
            self.session.info["creators_browsed"] = handles
            LOG.info("Browsing public Reels of %d creators: %s", len(handles), ", ".join(handles))
            for h in handles:
                if self._should_stop():
                    return
                lim = self.limit or self.c["creator_reels_limit"]
                tiles = self.browser.grid_collect(f"{base}/{h}/reels/", self.flags.stop, limit=lim,
                                                  pause=self.c["grid_scroll_pause_s"])
                if tiles is None:
                    LOG.warning("@%s: reels not accessible (private, renamed or removed)", h)
                    continue
                LOG.info("@%s: %d reels found", h, len(tiles))
                for t in tiles:
                    if self._should_stop():
                        break
                    self.seen.add(t["shortcode"])
                    self._queue_reel(t, {"kind": "creator", "creator": h})
                    self._wait_for_queue_room()
                self._refresh_cookies()
                self.progress()

    def _wait_for_queue_room(self) -> None:
        while self.pool.depth() >= self.c["queue_max"] and not self.flags.stop.is_set():
            self.flags.stop.wait(1)
        if self.guard and self.guard.wait_if_paused(self.flags.stop) == "stop":
            self.stop_reason = "resource pressure: " + "; ".join(self.guard.verdict.reasons or ["paused too long"])
            LOG.error("Stopping safely: %s", self.stop_reason)
            self.flags.stop.set()
        self.browser.enforce_tab_limit()

    def discover_creators(self) -> list[str]:
        """Creators represented in references from earlier Saved sessions, most frequent first."""
        counts: Counter = Counter()
        for d in session_dirs(self.cfg.sessions_dir):
            for e in (read_json(d / "metadata.json", {}) or {}).get("videos", []):
                if (e.get("source") or {}).get("kind") == "saved" and e.get("creator") and e.get("status") == "downloaded":
                    counts[e["creator"]] += 1
        mine = self.cfg["instagram"]["account"]
        return [c for c, _ in counts.most_common() if c != mine][: self.c["creators_max"]]

    def _write_creators(self) -> None:
        """creators.json: who is represented in this session (discovery output)."""
        by: dict[str, dict] = {}
        for e in self.session.entries:
            if e.get("creator") and e["status"] in ("downloaded", "queued", "duplicate"):
                d = by.setdefault(e["creator"], {"creator": e["creator"], "name": e.get("creator_name"), "references": 0,
                                                 "sources": []})
                d["references"] += 1
                k = (e.get("source") or {}).get("kind")
                if k and k not in d["sources"]:
                    d["sources"].append(k)
        if by:
            write_json(self.session.path / "creators.json",
                       {"session": self.session.id, "creators": sorted(by.values(), key=lambda x: -x["references"])})

    # ---- RESUME: finish queued/failed downloads of an earlier session in its own folder -----------------------
    def _resume_queued(self) -> None:
        todo = [e for e in self.session.entries if e["status"] in ("queued", "downloading", "interrupted", "failed")]
        LOG.info("Resuming %d unfinished downloads", len(todo))
        for e in todo:
            self.session.update(e, status="queued", error=None)
            self.pool.submit(e)
        self.known = known_videos(self.cfg.sessions_dir) if self.c["dedupe_across_sessions"] else {}
        while self.pool.depth() and not self.flags.stop.is_set():
            self.progress()
            self.flags.stop.wait(1)

    # ---- NORMAL mode (previous behaviour): steer with the LLM, watch, download synchronously -------------------
    def _loop(self) -> None:
        state = {"empty": 0, "stuck": 0}
        while not self._should_stop():
            if not self._housekeeping():
                break
            reel = self._next_reel(state)
            if reel is None:
                continue
            self._reels_since_recycle += 1
            self._handle(reel)
            self.progress()
            if not self._should_stop():
                self._scroll_on()

    def _handle(self, reel: dict) -> None:
        s, code = self.session, reel["shortcode"]
        entry = s.add({"id": code, "url": reel["url"], "creator": reel.get("creator"),
                       "caption": reel.get("caption") or None, "caption_source": "feed" if reel.get("caption") else None,
                       "duration_hint_s": reel.get("duration"), "source": {"kind": "reels_feed"}})
        if code in self.known:
            k = self.known[code]
            s.update(entry, status="duplicate", duplicate_of={"session": k["session"], "file": k["file"]})
            LOG.info("[%s] duplicate of %s/%s", code, k["session"], k["file"])
            return
        progress = {"seen": len(self.seen), "downloaded": s.counts().get("downloaded", 0)}
        d = self.steer.decide(reel, progress)
        s.update(entry, agent_decision={"action": d.action, "reason": d.reason, "source": d.source})
        LOG.info("[%s] @%s -> %s (%s: %s)", code, reel.get("creator"), d.action, d.source, d.reason)
        self.flags.stop.wait(d.dwell_s or random.uniform(*self.c["dwell_s"]))  # natural watch time
        if d.action == "download":
            self._download(entry, use_browser=True)
        else:
            s.update(entry, status="skipped")

    # ---- download with retries (used by both the pool workers and normal mode) ---------------------------------
    def _download(self, entry: dict, use_browser: bool = True) -> None:
        s = self.session
        retries, backoff = self.c["download_retries"], self.c["retry_backoff_s"]
        res = DownloadResult(False, error="not attempted", kind="failed")
        for attempt in range(1, retries + 1):
            if self.flags.abort.is_set():
                break
            s.update(entry, attempts=entry["attempts"] + 1, status="downloading")
            res = self._try_once(entry, use_browser)
            if res.ok:
                self._ingest(entry, res)
                self.consecutive_failures = 0
                return
            LOG.warning("[%s] attempt %d/%d failed (%s): %s", entry["id"], attempt, retries, res.kind, res.error)
            s.update(entry, error=res.error)
            if res.kind in ("unavailable", "aborted") or attempt == retries:
                break
            self.flags.abort.wait(backoff[min(attempt - 1, len(backoff) - 1)])
        if res.kind == "aborted" or self.flags.abort.is_set():
            s.update(entry, status="queued", error=None)  # persisted and resumable, not lost
            return
        status = "unavailable" if res.kind == "unavailable" else "failed"
        s.update(entry, status=status, error=res.error)
        if status == "failed":
            with self._lock:
                self.consecutive_failures += 1
        LOG.warning("[%s] %s - URL recorded: %s", entry["id"], status, entry["url"])

    def _try_once(self, entry: dict, use_browser: bool = True) -> DownloadResult:
        cookies = self.browser.cookie_file
        if use_browser:  # normal mode runs on the browser thread, so it may open the permalink tab
            try:
                if self.c["open_permalink"]:
                    page_meta = self.browser.open_permalink(entry["url"])
                    if page_meta.get("og_description") and not entry.get("caption"):
                        entry["caption"], entry["caption_source"] = page_meta["og_description"], "permalink"
                cookies = self.browser.export_cookies()
            except ChallengeDetected:
                return DownloadResult(False, error="challenge/login wall on permalink (solve manually)", kind="unavailable")
            except Exception as e:  # noqa: BLE001
                if self.flags.stop.is_set():
                    return DownloadResult(False, error="stopped", kind="aborted")
                return DownloadResult(False, error=f"browser error opening permalink: {str(e)[:200]}", kind="transient")
        try:
            return self.downloader(entry["url"], self.session.partial_dir, cookies, self.c["format"],
                                   self.c["download_timeout_s"], self.flags.abort)
        finally:
            if use_browser:
                cookies.unlink(missing_ok=True)  # normal mode: no plaintext session-cookie copy left behind

    def _ingest(self, entry: dict, res: DownloadResult) -> None:
        import hashlib
        dest = self.session.ingest(res.file)
        sha = hashlib.sha256()
        with open(dest, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                sha.update(chunk)
        info = res.info
        fields = dict(
            status="downloaded", error=None, file=f"videos/{dest.name}", downloaded_at=now_iso(),
            bytes=dest.stat().st_size, sha256=sha.hexdigest(), probe=info.get("probe"),
            creator=entry.get("creator") or info.get("channel") or info.get("uploader_id") or info.get("uploader"),
            creator_name=info.get("uploader"), creator_id=info.get("uploader_id"),
            posted_at=info.get("timestamp"), source_info={k: v for k, v in info.items() if k != "probe"},
            download_method="yt-dlp",
        )
        if info.get("description"):
            fields.update(caption=info["description"], caption_source="downloader")
        self.session.update(entry, **fields)
        with self._lock:
            self.known[entry["id"]] = {"session": self.session.id, "file": fields["file"]}
        LOG.info("[%s] saved %s (%.1f MB, %.1fs)", entry["id"], dest.name, dest.stat().st_size / 1e6,
                 (info.get("probe") or {}).get("duration_s") or 0)

    def _retry_failed(self) -> None:
        failed = [e for e in self.session.entries if e["status"] == "failed"]
        if not failed:
            return
        LOG.info("Final retry pass for %d failed downloads", len(failed))
        self._refresh_cookies(force=True)
        for e in failed:
            if self.flags.abort.is_set() or self.flags.presses > 1:
                break
            res = self._try_once(e, use_browser=False)
            if res.ok:
                self._ingest(e, res)
            else:
                self.session.update(e, error=res.error)
