# Visual Intelligence Engine

A self-hosted research platform for short-form video: **collect** videos (Instagram Reels, Saved, creators), **organise**
them in a SQLite library with first-class scrolling sessions, **inspect** them in a fast local dashboard, and **analyse**
how they were made using the agent runtimes you already have — Claude Code, OpenAI Codex CLI, Google Antigravity, or your
own Sarness server.

> It is **not an AI model**. No LLM, VLM, Ollama, llama.cpp, PyTorch or CUDA is bundled, downloaded or run here.
> `./collect.sh` never calls an LLM. Analysis happens only when you press Start / run `analyse`.

```bash
npm install
npm run dev          # → http://127.0.0.1:5173   no account, no keys, no Docker
```
First start creates `data/vie.sqlite` and imports your existing `scroll-sessions/` (read-only; nothing is copied, moved or re-downloaded).

## What you get

| | |
|---|---|
| **Overview** | totals, collected/day, storage growth, by source and classification, date ranges, live machine stats |
| **Library** | windowed grid/table for tens of thousands of videos, real thumbnails, range-seekable player, text + 20 filters, multi-select, bookmarks/tags/notes, editable multi-label classification |
| **Sessions** | every scrolling run, incomplete/crashed ones flagged honestly, per-session errors, log, new disk use, “analyse this session” |
| **Analysis Studio** | explicit selection → depth (Level 0–3) → agent → limits → Start; estimate from *measured* past cost; queue, pause, cancel, retry, export |
| **Storage** | usage by kind, free space, orphans/duplicates, two-step typed-confirmation cleanup |
| **Settings** | collector concurrency & resource limits (written to `config.toml`), providers, profiles, Sarness, retention, export/import |
| **CLI** | `./visualintelligence status \| videos \| sessions \| analyse \| jobs \| providers \| doctor \| serve …` ([CLI.md](docs/CLI.md)) |
| **MCP** | 17 read tools + 7 curated write/action tools, stdio or token-gated HTTP ([MCP.md](docs/MCP.md)) |
| **Remote collectors** | desktop collects, server stores/analyses; authenticated resumable push ([SERVER.md](docs/SERVER.md)) |

## Collecting (unchanged workflow, now crash-safe)

```bash
./setup.sh                    # once: Python venv, yt-dlp, Playwright Chromium
./collect.sh                  # FAST mode (default): glance 5–7 s, queue full download, no LLM
./collect.sh --source saved | --source creators | --mode normal | --resume [SESSION]
```
The collector now runs the browser in software-rendering mode, recycles it, refuses a second instance, watches RAM/swap/disk/GPU
and the kernel log, and stops itself safely before the desktop can freeze — see [docs/RESOURCES.md](docs/RESOURCES.md) for the
investigation of the freezes (NVIDIA VA-space exhaustion), what was changed and what is still uncertain. Original collector docs: [docs/COLLECTOR.md](docs/COLLECTOR.md).

## Analysing

```bash
./visualintelligence providers list
./visualintelligence analyse --next 5 --provider claude --profile quick --dry-run     # shows exactly what would run
./visualintelligence analyse --video v_… --provider codex --profile standard
```
Agents are given still frames (+ contact sheet, shot list) and told so; results are structured labels with evidence, a
research verdict, and stated limitations — see [docs/PROVIDERS.md](docs/PROVIDERS.md). Human corrections never overwrite agent output.

## Server edition

```bash
npm run build && npm run start            # 127.0.0.1:3000, plain Node, ~80 MB idle
deploy/install.sh --user --port 3100 --host <LAN-IP>        # systemd, token auth, resource-capped
```
Never binds a non-loopback address without a token or an explicit `VIE_TRUSTED_LAN=1`. [docs/SERVER.md](docs/SERVER.md).

## Tests

```bash
npm run build && npm test                 # 36 TypeScript tests incl. end-to-end against the production server
.venv/bin/python -m pytest tests -q       # 44 Python tests: collector e2e (real Chromium + yt-dlp on a mock site), resource safety
npm run check                             # svelte-check / tsc
```

## Docs
[Architecture](docs/ARCHITECTURE.md) · [Resources & the freezes](docs/RESOURCES.md) · [Providers & taxonomy](docs/PROVIDERS.md) · [CLI](docs/CLI.md) · [MCP](docs/MCP.md) · [Server & remote collectors](docs/SERVER.md) · [Migration](docs/MIGRATION.md) · [Collector](docs/COLLECTOR.md) · [Changelog](CHANGELOG.md)

## Privacy
No telemetry. Instagram cookies/profile live outside the repo (`~/.local/share/visualintelligence-engine`, mode 700/600) and are git-ignored; so are `scroll-sessions/`, `data/`, `config.toml`, tokens and databases.
