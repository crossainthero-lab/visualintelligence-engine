"""Playwright wrapper: persistent visible Chromium profile, login handling, Reels feed extraction."""
from __future__ import annotations

import os
import random
import re
import threading
import time
from pathlib import Path

from .download import write_cookies_file
from .resources import reap_orphan_browsers
from .util import LOG

RESERVED = {"reels", "reel", "audio", "explore", "direct", "accounts", "p", "stories", "tv", "about", "legal", "api", "web"}

EXTRACT_JS = r"""
(reserved) => {
  const vh = window.innerHeight;
  let best = null, bestVis = 0;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    const vis = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (vis > bestVis) { bestVis = vis; best = v; }
  }
  if (!best || bestVis < Math.min(vh, best.getBoundingClientRect().height) * 0.5) return null;
  // Real Instagram: the Reels feed keeps the active reel's id in the URL (/reels/<code>/); in-page links only
  // point at the creator and the audio page (/reels/audio/<id>/), which must never be mistaken for a reel.
  const permRe = /^\/(?:[\w.]+\/)?(reel|reels|p)\/(?!audio\/)([\w-]{5,})/;
  let perm = permRe.exec(location.pathname);
  const credRe = /^\/([\w.]+)\/(?:reels\/)?$/;
  let el = best, scope = best.parentElement, creator = null;
  for (let i = 0; i < 16 && el.parentElement; i++) {
    el = el.parentElement; scope = el;
    if (!perm) perm = [...el.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))
      .map(h => { try { return new URL(h, location.href).pathname; } catch (e) { return ''; } })
      .map(p => permRe.exec(p)).find(Boolean);
    for (const a of el.querySelectorAll('a[href]')) {
      const m = credRe.exec(a.getAttribute('href') || '');
      if (m && !reserved.includes(m[1])) { creator = m[1]; break; }
    }
    if (creator) break;
  }
  if (!perm) return null;
  let caption = (scope.innerText || '').replace(/\s+/g, ' ').trim();
  if (creator) caption = caption.replace(new RegExp('^.*?' + creator.replace(/\./g, '\\.') + '\\s*'), '');
  return { shortcode: perm[2], kind: perm[1], creator, caption: caption.slice(0, 600),
           duration: isFinite(best.duration) ? best.duration : null, current_time: best.currentTime };
}
"""

DISMISS_JS = r"""
() => {
  const labels = ['not now', 'cancel', 'close', 'decline optional cookies', 'allow essential cookies only'];
  for (const b of document.querySelectorAll('button, div[role="button"]')) {
    const t = (b.innerText || '').trim().toLowerCase();
    if (labels.includes(t) && b.getBoundingClientRect().height > 0 && b.closest('[role="dialog"]')) { b.click(); return t; }
  }
  return null;
}
"""


class ChallengeDetected(RuntimeError):
    pass


class _BrowserBase:
    def __init__(self, cfg, headless: bool | None = None):
        self.cfg = cfg
        self.headless = cfg["browser"]["headless"] if headless is None else headless
        self.profile = cfg.state_dir / "browser-profile"
        self.cookie_file = cfg.state_dir / "cookies.txt"
        self.pw = None
        self.ctx = None
        self.page = None

    # ---- lifecycle ---------------------------------------------------------------------------
    def start(self) -> None:
        from playwright.sync_api import sync_playwright

        self.cfg.state_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.cfg.state_dir, 0o700)
        self.profile.mkdir(exist_ok=True)
        os.chmod(self.profile, 0o700)
        b = self.cfg["browser"]
        self.pw = sync_playwright().start()
        kw = dict(headless=self.headless, viewport={"width": b["viewport"][0], "height": b["viewport"][1]},
                  handle_sigint=False, handle_sigterm=False, locale="en-US", args=self.chromium_args())
        if b.get("channel"):
            kw["channel"] = b["channel"]
        self.ctx = self.pw.chromium.launch_persistent_context(str(self.profile), **kw)
        self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()
        LOG.info("Browser started (profile %s)", self.profile)

    def chromium_args(self) -> list[str]:
        """Collector browsing never needs the GPU. The 2026-10-19 freezes were NVIDIA VA-space exhaustion followed by an
        RC-watchdog GPU lock-up while this browser decoded 1440x2560 reels on the GPU; software mode keeps Chromium
        away from the NVIDIA driver entirely (see docs/RESOURCES.md)."""
        b = self.cfg["browser"]
        args = []
        if b.get("gpu", "software") == "software":
            args += ["--disable-gpu", "--disable-gpu-compositing", "--disable-gpu-rasterization",
                     "--disable-accelerated-video-decode", "--disable-accelerated-video-encode",
                     "--disable-accelerated-2d-canvas", "--disable-features=VaapiVideoDecoder,VaapiVideoEncoder"]
        if b.get("mute", True):
            args.append("--mute-audio")
        return args

    def owned_pids(self) -> list[int]:
        from .resources import browser_pids
        return browser_pids(self.profile)

    def enforce_tab_limit(self) -> int:
        """Close surplus tabs (never the main page). Returns how many were closed."""
        closed = 0
        try:
            limit = max(1, int(self.cfg["browser"].get("max_tabs", 3)))
            extra = [p for p in self.ctx.pages if p is not self.page]
            while len(extra) + 1 > limit:
                extra.pop(0).close()
                closed += 1
        except Exception:
            pass
        if closed:
            LOG.warning("Closed %d surplus browser tab(s) (max_tabs=%s)", closed, self.cfg["browser"].get("max_tabs", 3))
        return closed

    def close(self) -> None:
        for fn in (lambda: self.ctx and self.ctx.close(), lambda: self.pw and self.pw.stop()):
            try:
                fn()
            except Exception:
                pass
        self.ctx = self.pw = self.page = None
        # Playwright occasionally leaves renderer/GPU helpers behind after a crash: reap only processes started with
        # OUR private profile directory, never anything else.
        try:
            reap_orphan_browsers(self.profile)
        except Exception:
            pass

    # ---- login ---------------------------------------------------------------------------------
    def logged_in(self) -> bool:
        return any(c["name"] == "sessionid" and c["value"] for c in self.ctx.cookies())

    def ensure_login(self, stop: threading.Event) -> None:
        self.page.goto(self.cfg["instagram"]["base_url"], wait_until="domcontentloaded")
        if self.logged_in():
            LOG.info("Existing Instagram session found in the saved profile.")
            return
        timeout = self.cfg["instagram"]["login_timeout_s"]
        LOG.warning("Not logged in. Log in as '%s' in the browser window (up to %ds). The session is saved "
                    "to %s for next time.", self.cfg["instagram"]["account"], timeout, self.profile)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not stop.is_set():
            if self.logged_in():
                time.sleep(2)  # let cookies settle
                LOG.info("Login detected.")
                return
            stop.wait(1.0)
        if not stop.is_set():
            raise RuntimeError("login timed out; re-run ./collect.sh and log in")

    def export_cookies(self) -> Path:
        cookies = [c for c in self.ctx.cookies() if "instagram" in c["domain"] or "cdninstagram" in c["domain"]]
        write_cookies_file(cookies, self.cookie_file)
        return self.cookie_file

    # ---- challenge handling (we never solve these: a human must) ---------------------------------
    def challenge_active(self, page=None) -> bool:
        page = page or self.page
        url = page.url
        if re.search(r"/(challenge|checkpoint|suspended|accounts/login)", url):
            return True
        try:
            return page.locator("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='captcha']").count() > 0
        except Exception:
            return False

    def wait_for_human(self, stop: threading.Event, timeout: float = 900) -> bool:
        LOG.warning("Instagram is showing a challenge/login/CAPTCHA page (%s). Solve it yourself in the "
                    "browser; the collector is paused and will never try to bypass it.", self.page.url)
        end = time.monotonic() + timeout
        while time.monotonic() < end and not stop.is_set():
            if not self.challenge_active():
                LOG.info("Challenge cleared, resuming.")
                return True
            stop.wait(2.0)
        return False

    # ---- feed ----------------------------------------------------------------------------------
    def open_feed(self) -> None:
        self.page.goto(self.cfg["instagram"]["start_url"], wait_until="domcontentloaded")
        self.page.wait_for_timeout(2500)
        self.dismiss_popups()

    def dismiss_popups(self) -> None:
        try:
            self.page.evaluate(DISMISS_JS)
        except Exception:
            pass

    def current_reel(self) -> dict | None:
        try:
            r = self.page.evaluate(EXTRACT_JS, sorted(RESERVED))
        except Exception as e:
            if "closed" in str(e).lower() or "crash" in str(e).lower():
                raise
            return None
        if r:
            base = self.cfg["instagram"]["base_url"].rstrip("/")
            seg = "reel" if r["kind"] in ("reel", "reels") else "p"
            r["url"] = f"{base}/{seg}/{r['shortcode']}/"
        return r

    def next_reel(self) -> None:
        """Scroll like a person: one wheel notch / arrow key, with jitter."""
        if random.random() < 0.5:
            self.page.keyboard.press("ArrowDown")
        else:
            self.page.mouse.move(random.randint(400, 800), random.randint(300, 600))
            self.page.mouse.wheel(0, random.randint(700, 900))
        self.page.wait_for_timeout(random.randint(900, 1800))

    def current_path(self) -> str:
        try:
            return self.page.evaluate("location.pathname")
        except Exception:
            return ""

    def open_permalink(self, url: str) -> dict:
        """Open the reel in a second tab and read what the page itself says (title/description)."""
        tab = self.ctx.new_page()
        try:
            tab.goto(url, wait_until="domcontentloaded", timeout=30000)
            tab.wait_for_timeout(1200)
            if self.challenge_active(tab):
                raise ChallengeDetected(tab.url)
            meta = tab.evaluate("""() => ({
              og_title: document.querySelector('meta[property="og:title"]')?.content || null,
              og_description: document.querySelector('meta[property="og:description"]')?.content
                              || document.querySelector('meta[name="description"]')?.content || null})""")
            return meta
        finally:
            try:
                tab.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------------------------------
# Grid sources (Saved, collections, creator profiles) and approval-gated controls for training
# ---------------------------------------------------------------------------------------------------
TILES_JS = r"""
() => {
  const re = /\/(?:[\w.]+\/)?(?:p|reel)\/([\w-]{5,})\/?/;
  const out = [];
  for (const a of document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')) {
    const m = re.exec(a.getAttribute('href') || '');
    if (!m) continue;
    const ic = a.querySelector('svg[aria-label]');
    out.push({ shortcode: m[1], icon: ic ? ic.getAttribute('aria-label') : null, href: a.getAttribute('href') });
  }
  return out;
}
"""

BAND_JS = r"""
() => { const vh = innerHeight; let best = null, bv = 0;
  for (const v of document.querySelectorAll('video')) { const r = v.getBoundingClientRect();
    const vis = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)); if (vis > bv) { bv = vis; best = r; } }
  return best ? { top: best.top, bottom: best.bottom, left: best.left, right: best.right } : null; }
"""


def tile_to_reel(base_url: str, t: dict) -> dict:
    seg = "reel" if t.get("icon") == "Clip" else "p"
    return {"shortcode": t["shortcode"], "url": f"{base_url.rstrip('/')}/{seg}/{t['shortcode']}/",
            "tile_type": t.get("icon") or "post"}


class GridMixin:
    def grid_collect(self, url: str, stop: threading.Event, limit: int = 0, pause: float = 1.4,
                     max_idle: int = 4) -> list[dict] | None:
        """Open a grid page and scroll until it stops growing. Returns tiles in page order, or None if the
        page is unavailable (private, missing, no access)."""
        base = self.cfg["instagram"]["base_url"]
        self.page.goto(url, wait_until="domcontentloaded")
        self.page.wait_for_timeout(3500)
        if self.challenge_active():
            if not self.wait_for_human(stop):
                return None
        try:
            if self.page.locator("text=/Sorry, this page isn't available|This account is private/i").count():
                return None
        except Exception:
            pass
        seen: dict[str, dict] = {}
        idle = 0
        while not stop.is_set() and idle < max_idle:
            for t in self.page.evaluate(TILES_JS):
                if t["shortcode"] not in seen:
                    seen[t["shortcode"]] = tile_to_reel(base, t)
            n = len(seen)
            if limit and n >= limit:
                break
            self.page.mouse.wheel(0, 2800)
            self.page.wait_for_timeout(int(pause * 1000))
            for t in self.page.evaluate(TILES_JS):
                if t["shortcode"] not in seen:
                    seen[t["shortcode"]] = tile_to_reel(base, t)
            idle = idle + 1 if len(seen) == n else 0
        out = list(seen.values())
        return out[:limit] if limit else out

    def saved_collections(self, account: str) -> list[dict]:
        """Named collections on /<account>/saved/ (plus Instagram's default 'All posts')."""
        base = self.cfg["instagram"]["base_url"].rstrip("/")
        self.page.goto(f"{base}/{account}/saved/", wait_until="domcontentloaded")
        self.page.wait_for_timeout(4000)
        cards = self.page.evaluate("""(acct) => [...document.querySelectorAll('main a[href*="/saved/"]')].map(a => ({
            path: a.getAttribute('href'), name: (a.innerText || '').replace(/\\s+/g, ' ').trim() }))
          .filter(c => c.path && c.path !== `/${acct}/saved/` && c.name)""", account)
        uniq, out = set(), []
        for c in cards:
            if c["path"] not in uniq:
                uniq.add(c["path"])
                out.append({"name": c["name"], "url": base + c["path"], "default": c["path"].endswith("/all-posts/")})
        return out


class ControlMixin:
    """Locate Like/Save/Follow on the active reel. Never clicks anything by itself."""

    def active_band(self) -> dict | None:
        return self.page.evaluate(BAND_JS)

    def find_control(self, action: str):
        band = self.active_band()
        if not band:
            return None
        if action in ("like", "save"):
            label = "Like" if action == "like" else "Save"  # 'Unlike' / 'Remove' => already done, not matched
            loc = self.page.locator(f"svg[aria-label='{label}']")
        elif action == "follow":
            loc = self.page.locator("div[role='button']:text-is('Follow'), button:text-is('Follow')")
        else:
            return None
        best, bd = None, 1e9
        for i in range(loc.count()):
            try:
                bb = loc.nth(i).bounding_box()
            except Exception:
                continue
            if not bb or bb["width"] == 0:
                continue
            cy = bb["y"] + bb["height"] / 2
            if band["top"] - 40 <= cy <= band["bottom"] + 40:
                d = abs(cy - (band["top"] + band["bottom"]) / 2)
                if d < bd:
                    best, bd = loc.nth(i), d
        if best is None:
            return None
        return best.locator("xpath=ancestor-or-self::*[@role='button' or self::button][1]") if action != "follow" else best

    def highlight(self, loc, secs: float = 1.5) -> None:
        try:
            loc.evaluate("e => { e.style.outline = '4px solid #ff2d55'; setTimeout(() => e.style.outline = '', %d) }" % int(secs * 1000))
        except Exception:
            pass


class BrowserSession(_BrowserBase, GridMixin, ControlMixin):
    """Dedicated, persistent, visible Chromium session (see _BrowserBase for lifecycle/login/feed)."""
