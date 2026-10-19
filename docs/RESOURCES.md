# Resource safety — the 2026-10-19 desktop freezes

## What the evidence says

Collected from the previous boots' kernel journal (`journalctl -b -N -k`) on the RTX 3060 desktop (driver 595.99.02, open kernel module):

| Boot ended | Collector session running | First NVIDIA error | Then |
|---|---|---|---|
| 19:23:55 | `2026-10-19_1916` (killed, 0-byte last file) | 19:19:27 `NVRM: dmaAllocMapping_GM107: can't alloc VA space for mapping … NV_ERR_NO_MEMORY` | repeating `RC watchdog: GPU is probably locked!` until reboot |
| 20:56:45 | `2026-10-19_2045` | 20:54:19 same | same |
| 21:44:31 | `2026-10-19_2122` (visible “Google Chrome for Testing” started 21:22:34) | 21:29:31 same, then `GL_GUILTY_CONTEXT_RESET`, “Restarting GPU process due to unrecoverable error” | 108 watchdog lines, collector still logging normally until the machine was power-cycled |

* **No RAM pressure** (30 GB RAM, swap untouched, no `oom`/`killed process` lines), **no hidden AI** (fast mode builds no LLM client; there was no model process), no thermal events.
* The failure is **GPU virtual-address-space exhaustion in the NVIDIA driver**, 5–10 minutes into a collector run, followed by a hung GPU channel. The only heavy GPU client was the collector's visible Chromium decoding/compositing 1440×2560 VP9 reels with GPU acceleration, in a feed that preloads the next reels, for hours.
* Side effect proved by the data: five “downloaded” files (`0011.mp4`, `0162–0165.mp4`) are **0 bytes**: the freeze hit before the OS flushed them, while `metadata.json` already said `downloaded`.

**Confidence.** The correlation (three boots, same sequence, always during a collector run, none outside) and the mechanism (browser GPU contexts → driver VA exhaustion) are strong. I could **not** reproduce the driver fault with a short synthetic page (40 s, 3 parallel 1440×2560 VP9 players: Chromium held 30–44 MB of GPU memory, no errors), so the exact leak inside the driver is unproven. Real Instagram feeds create/destroy many `<video>` elements for far longer. Treat “Chromium GPU path + long session” as the established cause and the driver as an unfixed co-factor. A newer driver might also help.

## What was changed

| Control | Where | Effect |
|---|---|---|
| **Software rendering by default** (`--disable-gpu`, `--disable-gpu-compositing`, `--disable-accelerated-video-decode`, `--disable-features=Vaapi…`, `--mute-audio`) | `vie/browser.py`, `[browser] gpu = "software"` | The collector browser holds **0 MB** of NVIDIA memory (measured, below). |
| **Browser recycling** every 60 reels / 20 min (profile and login persist) | `[browser] recycle_after_*` | Bounds any decoder/renderer/context leak. |
| **Tab cap** (3) | `[browser] max_tabs` | Surplus tabs closed each loop. |
| **One collector at a time** (`flock`, kernel-released even on SIGKILL) | `vie/resources.py InstanceLock` | A second `./collect.sh` exits with code 3 before creating anything. |
| **Owned-process tracking**, orphan reaping | `browser_pids()` matches only `--user-data-dir=<our profile>` | After a crash the next run cleans its own leftover Chromium; unrelated processes (including your normal Chrome) are never touched. |
| **Resource guard** (5 s sampler) | `ResourceGuard` | Pauses browsing, restarts the browser, or stops safely on: free RAM, swap, memory-stall PSI, load, free disk, whole-GPU memory %, memory held *by the collector browser*, **NVIDIA VA-space / RC-watchdog lines appearing in the kernel log during the run**. Thresholds in `[limits]`. Unknown readings never trigger anything. |
| **Bounded subprocesses** | `download_workers` ≤ 4 (hard), queue backpressure at 40, `nice -n 10`, timeouts everywhere (yt-dlp 300 s, ffprobe 60 s), own process group so Ctrl+C / timeout kills the whole tree | |
| **Signals** | SIGINT, SIGTERM, SIGHUP all request a graceful stop; finalisation can't be aborted by a second signal | |
| **Durable writes** | downloaded files and their directory are `fsync`ed *before* metadata says `downloaded` | Prevents the 0-byte files seen above. |
| **Crash recovery** | on start (under the lock): sessions still “running” whose process is gone → `interrupted`; `downloading` → `queued`; “downloaded” entries whose file is empty/missing → `queued` for `--resume` | Status fields only; no media deleted. |
| **Decoding avoided** | collection never decodes media (yt-dlp stream-copy, ffprobe only). Thumbnails/frames come from the dashboard on request: ffmpeg `-threads 1`, `nice 15`, `ionice -c3`, one at a time | |
| **No GPU anywhere in the app** | dashboard/CLI/MCP/analysis spawn only ffmpeg (CPU) and external agent CLIs | `doctor` shows “this app holds 0 MB” of GPU memory. |

## Measured (this machine, 2026-10-19; real runs, no estimates)

| Test | Result |
|---|---|
| Headed Chromium, 3 × 1440×2560 VP9 loop players, 60 s, **software mode** | owned GPU memory **0 MB**; RSS tree ≈ 1.35 GB (9 processes), stable; 0 processes left after close |
| Same page, 40 s, `gpu = "auto"` (old behaviour) | owned GPU memory 30–44 MB; RSS ≈ 1.3 GB |
| Production dashboard, idle | **≈ 80 MB RSS, 0 CPU ticks in 30 s, 7 threads** |
| Production dashboard while generating 422 thumbnails (ffmpeg, niced, 1 at a time) | 113 s total, server peak **83 MB** RSS, 9.7 MB of thumbnails |
| SQLite database for 460 videos / 12 sessions | 1.5 MB (media referenced in place, nothing copied) |
| 60 000-video synthetic library: text search + sort + deep page, creator filter | < 1.5 s combined (`tests-js/db-import.test.ts`) |
| `kill -9` of a running collector (mock site) | Chromium orphaned (as expected) → next start reaps it, marks the session `interrupted`+`recovered`; test passes |
| Forced “RAM pressure” (impossible threshold) | collector stopped itself, `status=interrupted`, reason recorded, `--resume` continues, no browser left behind |

## Remaining risk — said plainly

* The fix has been exercised against a **mock** site and synthetic video, not a multi-hour live Instagram session. I did not run a long live session on your desktop because the previous failure freezes it. **Recommended first live run**: `watch -n5 nvidia-smi` in another terminal and `./collect.sh --minutes 20`; the guard will stop the run itself if the kernel log shows driver errors.
* If something *else* on the desktop (your normal Chrome, the compositor) triggers the same driver fault, no collector change prevents it. The driver is the likely root; consider updating it or reporting the `NV_ERR_NO_MEMORY` / RC-watchdog sequence to NVIDIA.
* The guard can stop a run but cannot stop a driver hang that blocks the whole machine instantly.
