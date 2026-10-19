# Migration from the Python-only engine

Nothing is moved, rewritten or re-downloaded. `scroll-sessions/` stays exactly where it is and remains the collector's
write target. The dashboard/CLI import it **read-only**:

```bash
npm install
./visualintelligence sync --force        # or just open the dashboard: it syncs at start-up and via “Sync sessions”
./visualintelligence status
```
What the first import of the author's library produced (2026-10-19): 12 sessions, 460 unique videos, 427 media files
(3.31 GB) of which 5 are 0-byte files truncated by the freezes and are flagged `missing` (not playable) instead of counted
as healthy; 6 sessions flagged **incomplete** (collector died; counts are from the last metadata flush, end time estimated
from last activity and marked as such); 8 duplicate downloads avoided; 0 orphan files.

* Provenance is kept: `videos.provenance_json` lists every session that saw a video and where from (Reels feed / Saved
  collection / creator). Historic sessions have no resource statistics; that field is simply empty.
* `./collect.sh --resume <session>` re-fetches queued entries, including ones the collector next start re-queues because their file is empty.
* Database upgrades: migrations are append-only; before applying one to a non-empty database a copy is written to `data/backups/`.
* `analyse.sh` / `vie.sh` (the older Python analysis path) are untouched and still work; the dashboard's analysis is the new path.
