"""Feed Training: an interactive, approval-gated workflow for improving what Instagram recommends.

Nothing here acts on its own. The LLM may *suggest* an action per reel; the account is only touched when you
press a key. Desktop Instagram exposes Like, Save and Follow (and Explore > suggested people). It does NOT expose
"Your algorithm", Interested or Not interested, so those are explained for the mobile app (MOBILE_GUIDE).
Training is deliberately slow and human-paced: rapid skipping teaches Instagram the wrong things.
"""
from __future__ import annotations

import random
import threading
import time
from pathlib import Path

from .steer import LLMClient, LLMError
from .util import LOG, write_json

DISCIPLINES = ("motion graphics / kinetic typography", "creative website design & web interaction",
               "3D animation & product visualisation", "AI-generated film / Seedance / video workflows",
               "AI production tutorials (e.g. Higgsfield prompting)", "luxury jewellery & product advertising",
               "cinematography, photography & VFX", "graphic design & branding", "other visual craft")

MOBILE_GUIDE = """\
What desktop Instagram cannot do - use the Instagram APP on your phone (logged in as the same account):
  1. Reels tab -> tap the 'Your algorithm' pill at the top (or Settings and activity -> Content preferences ->
     'Your algorithm'): add the topics you want more of (motion graphics, web design, 3D, AI video, product
     cinematography, jewellery advertising, branding, VFX...) and remove ones you do not want.
  2. On any reel you like, tap the three dots -> 'Interested'; on off-target ones -> 'Not interested'. Do it
     deliberately and sparingly; a handful of clear signals beat hundreds of rapid taps.
  3. Profile -> Following -> tap a creator -> 'Favorites' to pin the best creators to the Favorites feed
     (desktop shows that feed at instagram.com/?variant=favorites; yours is currently empty).
  4. Keep Saving the references you want more of - Saves are a strong signal and are what ./collect.sh --source
     saved collects."""

SYSTEM = """You help tune an Instagram account's recommendations for a visual-creative research archive.
The goal is a BALANCED, high-quality feed across these disciplines: {disciplines}.
Approved so far (discipline: count): {counts}. Prefer reels from under-represented disciplines.
You only SUGGEST. Reply JSON only: {{"action":"save"|"like"|"follow"|"skip","discipline":"<one of the list or 'other visual craft'>",
"reason":"<short>"}}. Use "save" for reels worth keeping as references, "follow" only for a creator who clearly keeps
producing this quality, "skip" for off-target content (memes, talking heads, vlogs, generic AI slop)."""


class Trainer:
    def __init__(self, cfg, browser, client: LLMClient | None, input_fn=input, out=print, dry_run: bool = False,
                 stop: threading.Event | None = None, rng: random.Random | None = None, max_reels: int = 0):
        self.cfg, self.b, self.client = cfg, browser, client
        self.input, self.out, self.dry = input_fn, out, dry_run
        self.stop = stop or threading.Event()
        self.rng = rng or random.Random()
        self.max_reels = max_reels
        self.log: list[dict] = []
        self.counts: dict[str, int] = {}
        self.seen: set[str] = set()

    # ---- suggestion ----------------------------------------------------------------------------------------
    def suggest(self, reel: dict) -> dict:
        if not self.client:
            return {"action": "skip", "discipline": "?", "reason": "no LLM available: decide manually"}
        try:
            out = self.client.chat_json(
                SYSTEM.format(disciplines="; ".join(DISCIPLINES), counts=self.counts or "none yet"),
                f"Creator: @{reel.get('creator')}\nCaption: {(reel.get('caption') or '')[:500]!r}")
            act = str(out.get("action", "skip")).lower()
            return {"action": act if act in ("save", "like", "follow", "skip") else "skip",
                    "discipline": str(out.get("discipline", "other"))[:60], "reason": str(out.get("reason", ""))[:200]}
        except LLMError as e:
            return {"action": "skip", "discipline": "?", "reason": f"LLM unavailable ({e}); decide manually"}

    # ---- acting (only after explicit approval) --------------------------------------------------------------
    def perform(self, action: str, reel: dict) -> str:
        loc = self.b.find_control(action)
        if loc is None:
            return "control not found (already done, or Instagram changed its UI)"
        if self.dry:
            self.b.highlight(loc)
            return "dry-run: control found and highlighted, NOT clicked"
        loc.click()
        self.b.page.wait_for_timeout(900)
        return "clicked"

    def review_reel(self, reel: dict) -> bool:
        """Show one reel + suggestion, ask for approval. Returns False to quit."""
        sug = self.suggest(reel)
        self.out("")
        self.out(f"  @{reel.get('creator')}  https://www.instagram.com/reel/{reel['shortcode']}/")
        self.out(f"  caption: {(reel.get('caption') or '')[:160]!r}")
        self.out(f"  suggestion: {sug['action'].upper()}  [{sug['discipline']}] - {sug['reason']}")
        while True:
            ans = self.input("  [y] accept  [s]ave  [l]ike  [f]ollow  [Enter] skip  [q]uit > ").strip().lower()
            if ans in ("q", "quit"):
                return False
            action = {"y": sug["action"], "s": "save", "l": "like", "f": "follow", "": "skip", "n": "skip"}.get(ans)
            if action is None:
                self.out("  ?")
                continue
            break
        if action != "skip":
            result = self.perform(action, reel)
            self.out(f"  -> {action}: {result}")
            self.counts[sug["discipline"]] = self.counts.get(sug["discipline"], 0) + 1
            self.log.append({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "reel": reel["shortcode"], "creator": reel.get("creator"),
                             "action": action, "result": result, "suggested": sug})
        return True

    # ---- reels feed review -----------------------------------------------------------------------------------
    def run_reels(self) -> None:
        lo, hi = self.cfg["train"]["dwell_s"]
        state_empty = 0
        while not self.stop.is_set():
            reel = self.b.current_reel()
            if reel is None:
                state_empty += 1
                if state_empty % 6 == 0:
                    self.b.open_feed()
                self.stop.wait(1.5)
                continue
            state_empty = 0
            if reel["shortcode"] in self.seen:
                self.b.next_reel()
                continue
            self.seen.add(reel["shortcode"])
            self.stop.wait(self.rng.uniform(lo, hi))  # watch like a person before judging
            if not self.review_reel(reel):
                return
            if self.max_reels and len(self.seen) >= self.max_reels:
                return
            before = self.b.current_path()
            self.b.next_reel()
            for _ in range(8):
                if self.b.current_path() != before:
                    break
                self.stop.wait(0.5)

    # ---- suggested creators (Explore > People) -------------------------------------------------------------------
    def run_people(self, limit: int = 12) -> None:
        base = self.cfg["instagram"]["base_url"].rstrip("/")
        self.b.page.goto(f"{base}/explore/people/", wait_until="domcontentloaded")
        self.b.page.wait_for_timeout(3500)
        people = self.b.page.evaluate("""() => { const out = [], seen = new Set();
          for (const a of document.querySelectorAll('main a[href^="/"]')) {
            const m = /^\\/([\\w.]+)\\/$/.exec(a.getAttribute('href')); if (!m || seen.has(m[1])) continue;
            const row = a.closest('div[role="button"], div') ; seen.add(m[1]);
            out.push({handle: m[1], text: (a.closest('div')?.parentElement?.innerText || '').replace(/\\s+/g,' ').slice(0,120)}); }
          return out; }""")
        self.out(f"\n{len(people)} suggested accounts on Explore > People (Instagram's own suggestions).")
        for p in people[:limit]:
            if self.stop.is_set():
                return
            self.out(f"\n  @{p['handle']}  {p['text']}")
            ans = self.input("  open profile in the browser to judge? [o]pen  [Enter] next  [q]uit > ").strip().lower()
            if ans == "q":
                return
            if ans == "o":
                self.b.page.goto(f"{base}/{p['handle']}/", wait_until="domcontentloaded")
                self.b.page.wait_for_timeout(2500)
                ok = self.input("  follow this account? [y/N] > ").strip().lower() == "y"
                if ok:
                    loc = self.b.page.locator("button:text-is('Follow'), div[role='button']:text-is('Follow')").first
                    if loc.count() == 0:
                        self.out("  -> follow: control not found")
                        continue
                    if self.dry:
                        self.b.highlight(loc)
                        self.out("  -> dry-run: highlighted, NOT clicked")
                    else:
                        loc.click()
                        self.out("  -> followed")
                    self.log.append({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "creator": p["handle"], "action": "follow",
                                     "result": "dry-run" if self.dry else "clicked"})
                self.b.page.goto(f"{base}/explore/people/", wait_until="domcontentloaded")
                self.b.page.wait_for_timeout(2500)

    def save_log(self) -> Path | None:
        if not self.log:
            return None
        d = self.cfg.state_dir / "train"
        d.mkdir(parents=True, exist_ok=True)
        p = d / (time.strftime("%Y-%m-%d_%H%M%S") + ".json")
        write_json(p, {"dry_run": self.dry, "actions": self.log, "approved_by_discipline": self.counts})
        return p


def run_training(cfg, browser, client, dry_run: bool = False, input_fn=input, out=print) -> int:
    stop = threading.Event()
    out("Feed Training - nothing happens to your account unless you press a key to approve it.\n")
    out(MOBILE_GUIDE + "\n")
    t = Trainer(cfg, browser, client, input_fn, out, dry_run, stop)
    try:
        browser.start()
        browser.ensure_login(stop)
        what = input_fn("Review: [1] reels in your feed (default)   [2] suggested accounts   [q] quit > ").strip().lower()
        if what == "q":
            return 0
        if what == "2":
            t.run_people()
        else:
            browser.open_feed()
            t.run_reels()
    except KeyboardInterrupt:
        out("\nstopped.")
    finally:
        p = t.save_log()
        out(f"\n{len(t.log)} approved actions" + (f" (dry-run, none executed); log: {p}" if p else "."))
        browser.close()
    return 0
