# Server edition

Same code as local mode. Requirements: Node ≥ 22.18, ffmpeg. No Docker, no Python on the server, no GPU, no models.

## Install (systemd)

```bash
git clone <repo> visualintelligence-engine && cd visualintelligence-engine
deploy/install.sh --user --port 3100 --host 192.168.1.50          # user service, token auth (a random token is generated)
# or: deploy/install.sh --user --port 3100 --host 192.168.1.50 --trusted-lan   # no auth, explicit opt-in for a trusted LAN
```
It runs `npm ci && npm run build`, writes `~/.config/visualintelligence/server.env` (mode 600), installs a hardened unit
with `MemoryMax=1200M`, `CPUQuota=200%`, `TasksMax=256`, and enables it. Re-running upgrades in place. `deploy/uninstall.sh`
removes the service and keeps your data unless `--purge-data`.

## Configuration (environment, `server.env`)

| Variable | Meaning |
|---|---|
| `VIE_HOST` / `VIE_PORT` | bind address / port (default `127.0.0.1:3000`) |
| `VIE_AUTH_TOKEN` | dashboard + API token (login page, or `Authorization: Bearer`) |
| `VIE_TRUSTED_LAN=1` | allow a non-loopback bind **without** a token (explicit, logged at start-up) |
| `VIE_DATA_DIR`, `VIE_MEDIA_DIR` | database/thumbnails/cache; ingested media |
| `VIE_SESSIONS_DIR` | collector folder to import (when the collector runs on this machine) |
| `VIE_MCP_TOKEN`, `VIE_MCP_REMOTE_WRITE=1` | enable `/mcp`; allow its write tools |
| `VIE_ORIGIN` | public origin when behind a TLS reverse proxy |

**Never silent exposure:** `bin/start.mjs` exits with code 2 if the host is not loopback and neither `VIE_AUTH_TOKEN` nor
`VIE_TRUSTED_LAN=1` is set. Tokens cannot be changed from the browser. Health endpoint: `GET /api/health` (no data).
Logs: `journalctl --user -u visualintelligence`. Backups: `deploy/backup.sh` (SQLite `VACUUM INTO`, keeps 14).
Reverse proxy (nginx): proxy to `127.0.0.1:3100`, forward `Host` and `X-Forwarded-Proto`, allow 8 MB bodies on `/api/ingest/`.

## Collector on a different machine

```bash
# on the server
./visualintelligence collectors pair desktop            # prints a vic_… token once; only its hash is stored
# on the desktop (the machine with the browser)
export VIE_SERVER=http://192.168.1.50:3100 VIE_COLLECTOR_TOKEN=vic_…
.venv/bin/python -m vie.push --check
.venv/bin/python -m vie.push            # metadata only
.venv/bin/python -m vie.push --files    # also upload the videos
```
Uploads are content-addressed (sha256), chunked (4 MB), resumable from the server's byte offset, verified before they
become visible, and never repeated. Collector tokens can only reach `/api/ingest/*`.

| Topology | Disk on server | Playback/analysis on server | Notes |
|---|---|---|---|
| **Centralised** (`--files`) | everything | yes | single source of truth; needs space (your OptiPlex: check `df`) and LAN bandwidth |
| **Desktop storage + remote metadata** (default push) | metadata only | no (`remote` status; not in the default library) | tiny server, but the desktop must be on to view/analyse |
| **Selective** | chosen sessions | yes for those | push `--files <session>` for the sessions you care about, metadata for the rest |

Idempotent: pushing the same session again changes nothing; metadata-only entries upgrade to playable when their file is pushed later.
