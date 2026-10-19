# Changelog

## 0.2.0 — Visual Intelligence platform
**Collector safety**
- Software-rendered Chromium by default, browser recycling, tab cap, single-instance lock, owned-process tracking and orphan reaping, resource guard (RAM/swap/PSI/disk/GPU/kernel-log), bounded + niced downloads, SIGTERM/SIGHUP handling, durable `fsync` before “downloaded”, stale-session recovery.
- `--check` no longer contacts an LLM server in fast mode.
- `vie.push`: authenticated, resumable, content-addressed push to a server.
**Platform**
- SQLite library (videos, sessions, analyses, labels, corrections, tags) with migrations; read-only import of existing Scroll Sessions.
- SvelteKit dashboard: Overview, Library (virtualised grid/table, filters, bulk actions, player, human corrections), Sessions, Analysis Studio, Storage, Settings.
- Analysis orchestration for Claude Code, Codex, Antigravity and Sarness with Level 0–3 profiles, versioned taxonomy, evidence-preserving results, cancel/pause/limits.
- CLI (`visualintelligence`) and MCP server (stdio + token-gated HTTP).
- Server edition: `bin/start.mjs`, systemd installer, backups.

## 0.1.x
Python collector (fast/normal modes), Saved/creator sources, FFmpeg prep and agent launcher.
