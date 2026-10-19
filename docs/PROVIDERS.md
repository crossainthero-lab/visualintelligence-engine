# Analysis providers

Analysis is separate from collection and starts **only** from an explicit request (dashboard Start button, `analyse`
command, or MCP `create_analysis_job` with `confirm`). The dashboard works with zero providers configured.

A provider is `{ id, detect(), run(request, signal) }` (`core/analysis/types.ts`). Detection never calls a model.
Add one by implementing the interface and registering it in `core/analysis/providers/index.ts`.

| Provider | Mechanism | Auth | Images | Cost reporting | Status on the development machine |
|---|---|---|---|---|---|
| **Claude Code** | `claude -p --output-format json --allowedTools Read --add-dir <frames>`; agent opens the frame files | existing CLI login, no API key | yes (Read tool) | exact `total_cost_usd` per call | **tested**: tiny test + real Level-1 analysis (≈ USD 0.16, 24 s) |
| **OpenAI Codex CLI** | `codex exec --output-schema … -i frame…  -` in a read-only sandbox, prompt on stdin | existing CLI login | yes (`-i`) | tokens only, price unknown | **tested**: tiny test + real analysis (≈ 29 s) |
| **Google Antigravity** | `agy -p … --output-format json --add-dir <frames>` (documented print mode, `agy models`) | existing login | yes | tokens only | **tested**: tiny test + real analysis (≈ 51 s). Disabled by default (it can route to several vendors' models) — enable in Settings |
| **Sarness** | the documented HTTP API: `/v1/uploads`, `/v1/chat/conversations/*/generate` (SSE); the model runs on the remote GPU host | token from `VIE_SARNESS_TOKEN`, `~/.config/visualintelligence/sarness.token`, or Sarness Desktop's keyring entry | only if the server lists a model with `vision: true` | self-hosted (no price) | reachable and authenticated; a text request ran on the remote RTX 4070 Ti; **no vision model is loaded, so frame analysis is reported unavailable** rather than faked |

No provider accepts a video file directly here, so every provider is given **frames**: temporal limits are stated in the
prompt and recorded with each result (`input_json`). Video-capable backends can be added by an adapter that reports
`supports.video`.

## Profiles

| | Evidence | Use |
|---|---|---|
| **Level 0 `index`** | no AI: ffprobe facts, hashes, thumbnail | free; never counts as “analysed” |
| **Level 1 `quick`** | 6 frames @640 px + metadata | triage: likely category, worth a deeper look? |
| **Level 2 `standard`** | 14 frames @768 px + contact sheet + shot list | structured labels with frame/time evidence |
| **Level 3 `deep`** | 18 frames @1024 + a frame per long shot + 4-frame burst at a cut + contact sheet | plausible production workflow (always inference) |

## Taxonomy (`vi-taxonomy/1`, `core/taxonomy.ts`)

17 categories, 21 techniques, 13 specific observations; a video carries any number of them, each with confidence,
certainty (`observed|likely|possible`) and evidence. Unknown keys from an agent are kept as `custom:<key>`. Over-claiming keys
are rejected; “possible phone-filmed display” is a valid observation, “iPhone 16 Pro filming a MacBook” is not. Human
corrections (add/reject a label, override verdict) live in separate rows and survive re-analysis.

## Limits and safety

Concurrency default 1 (hard cap 3). Hard per-call timeout. No automatic retries (a retry is a new explicit request).
`--max-success`, `--max-cost` stop a batch; remaining queued items become `cancelled` with the reason. Cancel aborts the
child process group. Each run is recorded with the exact evidence given, usage, and cost where the provider reports it.
