# Visual Intelligence Research Engine

Standalone research tooling (not part of AgentDock): **collect** Instagram videos into *Scroll Sessions*, later
**analyse** a session with Claude Code or Codex to learn how the videos were designed and produced.

```
./setup.sh        # once: venv, deps, Playwright Chromium, config.toml
./collect.sh      # start a Scroll Session           (Ctrl+C to stop)
./analyse.sh      # pick a session + agent, launch   (days later is fine)
```

## 1. Setup

```bash
./setup.sh                      # needs python3>=3.11, ffmpeg (sudo apt install ffmpeg)
./collect.sh --check            # preflight: ffmpeg, deps, LLM server + model, saved login
```

Steering model (`config.toml -> [llm]`): by default it **reuses your Sarness Desktop connection**. The endpoint comes from
`~/.config/sarness/profiles.json` and the token is read at runtime from the same GNOME-keyring entry the app uses
(service `sarness`). Nothing is copied to disk; the token is redacted from logs. `VIE_LLM_API_KEY` overrides it.
It talks to `POST /v1/agent/completions` (stateless SSE). Tested model: `qwen3-coder:30b` (~1 s/decision);
`qwen3.5:9b` never leaves its hidden reasoning through this API, so it is not used. If the server is down the collector
falls back to a keyword heuristic and retries every minute. `api = "openai"|"ollama"` are also supported.

## 2. Collect

```bash
./collect.sh                                  # FAST mode (default), Reels feed, until Ctrl+C
./collect.sh --mode normal                    # previous behaviour: LLM-steered, watches each reel
./collect.sh --source saved                   # your Saved references -> a new Scroll Session
./collect.sh --source creators                # public Reels of creators found in your Saved sessions
./collect.sh --source creators --creators a,b --limit 12
./collect.sh --resume [SESSION]               # finish queued/failed downloads of an unfinished session
./collect.sh --mode train [--dry-run]         # interactive feed training (separate workflow)
./collect.sh --max-videos 25 --minutes 30 --workers 3
```

**Fast mode.** Per reel: record URL, id, creator, caption immediately -> stay 5-7 s (`fast_dwell_s`) -> queue the
*complete* download -> scroll on. Downloads run in a worker pool (`download_workers`, default 2) so browsing never
waits. No LLM filter and no content classifier: everything is kept; the analysis agent judges later. Progress line
every 10 s: visited / queued / downloading / downloaded / duplicates / failed.
Ctrl+C once: stop browsing, finish the queued downloads. Twice: abort active downloads; whatever is unfinished is
saved as `queued` in `metadata.json` (nothing is lost) and `./collect.sh --resume SESSION` completes it in the same
folder. Hard kills are recoverable the same way.

**Sources** are recorded per reel in `metadata.json -> source`: `{"kind":"reels_feed"}`,
`{"kind":"saved","collection":"All posts","collections":[...]}`, `{"kind":"creator","creator":"handle"}`.
Duplicates are detected across sessions and sources. `creators.json` in a session lists who is represented
(handle, references, sources). Nothing is ever unsaved, removed or reorganised on the account.

* The collector launches its **own** visible Chromium (Playwright's, never your Chrome profile) with a **persistent
  profile** (`~/.local/share/visualintelligence-engine/browser-profile`, mode 0700, outside the repo). First run: log in
  yourself; later runs reuse the session. A session-cookie file for yt-dlp is kept 0600 while running and deleted at exit.
* Each chosen reel is downloaded with **yt-dlp using your own logged-in cookies** (best available quality, stream-copy
  merge, no re-encode, no watermark). Browsing is read-only in every collection mode.
* CAPTCHAs/challenges are never bypassed: the collector pauses for you. Private/removed/non-video items become
  `unavailable` (URL kept). Transient failures retry with backoff plus a final retry pass.

```
scroll-sessions/2026-10-19_1730/
  videos/0001.mp4 ...     original files, read-only, never overwritten (numbers only increase)
  metadata.json           per reel: id, url, creator, caption, posted_at, source, status, attempts, error, sha256, probe
  session.json            status (running|completed|interrupted|error), mode, source, counts, resumes
  creators.json           creators represented in this session
  collector.log
  analysis/               written only by ./analyse.sh
```

### What this Instagram account exposes on desktop (inspected live, 2026-10-19; account `your_instagram_username`)

| Area | Result |
|---|---|
| Saved | `/<account>/saved/` works. One collection only: Instagram's default **All posts** (82 items: Reels + 1 carousel + 1 post). No custom collections exist. |
| Favourite accounts | Feature exists (`/?variant=favorites`) but the list is **empty**. Not the same thing as Saved. |
| "Your algorithm" topics, Interested / Not interested | **Not available on desktop** (no page, not in the "..." menu, Content preferences only has "Content from accounts you don't follow" and "Sensitive content"). Use the phone app: see below. |
| Actions available | Like, Save, Follow, Explore > People suggestions. |

### Feed training (`--mode train`)

Never automatic. For each reel (watched for 6-12 s like a person) the Sarness model *suggests* save/like/follow/skip
with a discipline tag, balancing across: motion graphics, creative websites, 3D/product viz, AI film/Seedance,
AI tutorials (Higgsfield), luxury/jewellery advertising, cinematography/VFX, graphic design/branding. You press
`y` (accept), `s`, `l`, `f` or Enter (skip). `--dry-run` only highlights the control. Option 2 reviews Explore >
People suggestions (you open a profile, then approve a follow). Approved actions are logged to
`~/.local/share/visualintelligence-engine/train/*.json`. For the controls desktop lacks, the mode prints these
phone steps: Reels tab -> **Your algorithm** (add/remove topics); three dots -> **Interested / Not interested**
(sparingly and deliberately); Profile -> Following -> creator -> **Favorites**; keep **Saving** references.

## 3. Analyse

```bash
./analyse.sh                                   # menu: choose session, then Claude Code / Codex / Auto
./analyse.sh --session latest --agent codex    # non-interactive
./analyse.sh --list                            # sessions, video counts, analysis status
./analyse.sh --probe                           # really test each agent's image understanding (1 tiny call each)
./analyse.sh --dry-run                         # prep + show the exact command, don't launch
./analyse.sh --export                          # merge all validated analyses into dataset/observations.jsonl
```

What happens: (1) deterministic **FFmpeg prep** (no AI): ffprobe facts, exact hard-cut times, shot list, pacing stats,
motion-energy/luma/colour timelines, palette, loudness, silences, audio onsets, tempo *estimate*, cut-to-beat sync,
timestamped frames (incl. frame-by-frame transitions and a motion burst), spectrogram; (2) the chosen agent starts
**interactively in your terminal** inside the session folder with the analysis prompt (`analysis/PROMPT.md`);
(3) the agent must view the frames, write `analysis/videos/<id>.json`, then cross-compare; (4) on exit the launcher
validates the outputs. **Auto** takes the first usable agent in `analysis.auto_order` (installed + logged in), demoting
any agent whose real image probe failed. Interrupted analysis resumes: valid per-video files are kept.

Outputs (all in `analysis/`): `prep/` (facts + frames), `videos/<id>.json` (observations vs inferences, with timestamps,
cited frames, confidence, uncertainties, recreation recipes), `patterns.json`, `design-languages/*.json|md`,
`recipes/*.md`, `report.md`, `status.json`. `./vie.sh validate <session>` rejects analyses that cite frames that don't
exist, observations without evidence, timestamps outside the video, or inferences not tied to observations.

Permissions: `analysis.permissions = "scoped"` (default) lets the agent edit files and run only `vie.sh`/ffmpeg/ffprobe
(Claude: allow-list; Codex: `workspace-write` sandbox, approvals on request). `"ask"` uses each tool's defaults.

## 4. Tests

```bash
.venv/bin/python -m pytest tests -q
```
Covers sessions, ingestion (no overwrite), the fast download queue, Ctrl+C/abort/resume, Saved/creator sources, approval-gated training, steering (OpenAI/Ollama APIs, token, dead server), the whole collector
against a **local mock site** (real Chromium + real yt-dlp + real SIGINT), FFmpeg prep on synthetic videos with known
cuts/beats, agent selection with fake CLIs, the launcher, and the validator.

## Known limits

* Instagram's markup changes often; feed selectors (`vie/browser.py`) and yt-dlp's Instagram extractor can break.
  Verified live on 2026-10-19 (login persistence, Reels navigation, downloads, Ctrl+C). Instagram can change any of this at any time.
* No second "downloader website" fallback is implemented (third-party sites are unreliable/unsafe); failures record the URL.
* Audio is never "listened to": only measured features, spectrogram and (if a tool provides one) a transcript.
