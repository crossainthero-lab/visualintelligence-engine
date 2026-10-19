# Architecture

Visual Intelligence is **not an AI model**. It collects, organises, inspects and analyses videos, and for analysis it
calls agent runtimes you already have (Claude Code, Codex CLI, Google Antigravity, your own Sarness server).
Nothing in this repository loads, bundles, downloads or runs a model.

```
 collecting machine (desktop)                       server / same machine
┌───────────────────────────────┐                  ┌──────────────────────────────────────────────┐
│ collect.sh  (Python)          │                  │ SvelteKit app  (Node ≥ 22.18, node:sqlite)   │
│  • Playwright Chromium (soft- │  files + JSON    │  • dashboard UI + JSON API                   │
│    ware rendering, recycled)  │ ───────────────► │  • remote ingest  /api/ingest/*  (token)     │
│  • yt-dlp (niced, ≤4 workers) │  (vie.push)      │  • MCP over HTTP /mcp  (token, read-only)    │
│  • resource guard, 1 instance │                  │ core/  — shared services (TS, no framework)  │
│  • writes scroll-sessions/    │                  │  db · importer · videos · sessions · stats   │
└──────────────┬────────────────┘                  │  media (ffmpeg) · storage · settings         │
               │ read in place (never moved)       │  analysis: profiles · prepare · prompt ·     │
               ▼                                   │            providers/* · runner              │
       same core/ via  ./visualintelligence (CLI) ─┤  mcp/server (stdio)                          │
                                                   └──────────────┬───────────────────────────────┘
                                                                  │ explicit requests only
                                  claude -p │ codex exec │ agy -p │ Sarness HTTP (remote GPU)
```

## Layers

| Layer | Where | Notes |
|---|---|---|
| Collector | `vie/*.py`, `collect.sh` | The original engine, kept. **Fast** mode is the default and never calls an LLM. Normal mode (LLM-steered browsing) only when you pass `--mode normal`. |
| Resource safety | `vie/resources.py` | Instance lock, owned-process tracking, guard (RAM / swap / PSI / disk / GPU / kernel-log), browser recycling. See [RESOURCES.md](RESOURCES.md). |
| Core services | `core/*.ts` | Plain TypeScript with no framework imports. Run unchanged under SvelteKit, the CLI and the MCP server (Node strips the types; no build step for the CLI). |
| Database | `core/db.ts`, `core/migrations/` | SQLite via the built-in `node:sqlite`: WAL, foreign keys, busy timeout, append-only migrations in one transaction each, automatic file copy before migrating an existing DB. |
| Importer | `core/importer.ts` | Reads the collector's `scroll-sessions/` **read-only**, incrementally, idempotently. Media is referenced in place (root + relative path), never copied. |
| Analysis | `core/analysis/` | Profiles → evidence preparation (ffmpeg) → versioned prompt → provider adapter → schema normalisation → labels + history. Details in [PROVIDERS.md](PROVIDERS.md). |
| UI | `src/` | SvelteKit 3 + Svelte 5. Library is windowed (virtualised): only visible rows exist in the DOM. |
| CLI / MCP | `cli/`, `core/mcp/` | Thin layers over the same services, [CLI.md](CLI.md), [MCP.md](MCP.md). |

## Data model (SQLite, `data/vie.sqlite`)

`videos` (one row per unique platform id; media root + relative path, probe facts, sha256, download/analysis state,
denormalised current verdict) · `creators` · `sessions` (first-class: times, mode, source, counts, **incomplete** flag + reason,
resource stats) · `session_videos` (many-to-many: one video can appear in many sessions without copying media) ·
`analyses` (one row per attempt: provider, model, profile, schema/prompt version, status, result, evidence given,
usage, error; **never overwritten**) · `analysis_batches` · `video_labels` (agent labels per analysis + human labels with
`analysis_id NULL`) · `video_current_labels` (rebuilt view of “what we currently believe”) · `corrections` (audit of every
human edit) · `tags`, `video_tags` · `settings` · `collectors`, `uploads` · `audit_log`.

Unknown stays unknown: nullable columns are `NULL`, never defaults. Sessions the collector never closed are marked
`incomplete` with a reason rather than given invented end times.

## Honest evidence handling

An agent never sees a video, only the evidence we hand it: N still frames (+ contact sheet, + detected shots for deeper
profiles). The prompt states this limitation, the result schema has a mandatory `limitations` field, labels need evidence
(frame / timestamp) or their confidence is capped at 0.5, and keys that assert certainty (`definitely_…`, `confirmed_…`)
are rejected. Equipment/software claims are phrased as “possible …” / “… -like” observations.

## Local vs server edition

One codebase. `npm run dev` (Vite, localhost, no credentials) and `npm run build && npm run start` (adapter-node, plain
Node process, ~80 MB idle) share `core/`. The server refuses to bind a non-loopback address unless an access token or an
explicit `VIE_TRUSTED_LAN=1` is configured. Browser-based collection needs a desktop and stays on the collecting
machine; the server needs no display. See [SERVER.md](SERVER.md) for the three storage topologies and their trade-offs.
