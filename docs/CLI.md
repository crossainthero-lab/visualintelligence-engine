# CLI reference

```
./visualintelligence <command> [options]        # repo-local launcher
visualintelligence <command> ...                # after `npm link` (bin: visualintelligence)
```
Add `--json` to any command for machine-readable output. Exit codes: `0` ok, `1` error, `2` doctor found failures,
`3` some analyses failed. Needs Node ≥ 22.18; no build step.

Only `analyse` and `providers test` can call an AI, and only when you run them. `analyse` refuses to run
non-interactively without `--yes`.

| Command | What it does |
|---|---|
| `status` | Library, sessions, jobs, collector state, RAM/disk/GPU in one screen |
| `sync [--force] [--dir D]` | Import the collector's Scroll Sessions (read-only, incremental). Other commands do this automatically unless `--no-sync` |
| `videos list [--q T] [--creator U] [--session ID] [--analysis analysed\|unanalysed] [--bookmarked] [--category K] [--technique K] [--min-relevance 0-1] [--sort S] [--limit N]` | List/search |
| `videos show <id>` | Full record |
| `videos bookmark\|unbookmark <id>...` · `videos tag <id> --add a,b [--remove c]` · `videos note <id> --text "…"` | Human curation |
| `videos label <id> --kind category\|technique\|observation --key K [--reject]` · `videos verdict <id> --useful useful\|not_useful\|uncertain [--relevance 0-1]` | Human classification corrections (agent output preserved) |
| `sessions list` · `sessions show <id>` | Sessions, incl. incomplete flags |
| `storage [--inspect]` | Usage by kind, free space, orphans, duplicate content |
| `analyse …` | See below |
| `jobs list [--status S]` · `jobs show <uid>` · `jobs cancel\|pause\|resume <batch>` · `jobs cancel-one\|retry <analysis>` | Job control |
| `providers list` · `providers test <id> [--model M]` | Detect agents; `test` makes one tiny image call |
| `thumbnails [--limit N]` | Generate missing thumbnails (ffmpeg, niced, one at a time) |
| `export [--format json\|jsonl\|csv] [--all] [--out F]` | Structured research export |
| `collectors pair <name>` · `collectors list` · `collectors revoke <id>` | Credentials for remote collector machines |
| `doctor [--remote]` | Diagnostics, never calls an AI |
| `serve [--dev] [--host H] [--port P]` | Start the dashboard |
| `mcp` | MCP server on stdio |
| `backup [--out F]` · `settings [set '<json>']` | Maintenance |

## analyse

```
visualintelligence analyse (--video ID… | --session ID | --next N | --creator U | --bookmarked | --ids-file F | --stdin)
        --provider claude|codex|antigravity|sarness   --profile index|quick|standard|deep
        [--model M] [--limit N] [--max-success N] [--max-cost USD] [--concurrency N]
        [--reanalyse] [--dry-run] [--yes] [--queue-only]
```
Nothing is selected implicitly. `--dry-run` prints the exact selection and estimate and stops. `--max-success` and
`--max-cost` are hard stops (cost limits need a provider that reports prices; Claude does). `--queue-only` leaves the
batch for a running dashboard to pick up. Re-analysis keeps all earlier results.

Examples
```bash
./visualintelligence analyse --next 10 --provider claude --profile quick --dry-run
./visualintelligence analyse --session 2026-10-19_2122 --provider codex --profile quick --limit 10 --max-success 5
./visualintelligence analyse --video v_abc… --video v_def… --provider claude --profile deep --yes
./visualintelligence videos list --bookmarked --json | jq -r '.videos[].uid' | ./visualintelligence analyse --stdin --provider antigravity --profile standard
```
