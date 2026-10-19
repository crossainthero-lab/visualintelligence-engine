// Schema migrations, embedded as strings so they survive bundling (SvelteKit build, single-file CLIs).
// Rules: append-only, each runs in one transaction, never edit a shipped migration.
export interface Migration {
	version: number;
	name: string;
	sql: string;
}

export const migrations: Migration[] = [
	{
		version: 1,
		name: 'init',
		sql: `
CREATE TABLE media_roots (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT,
  kind TEXT NOT NULL DEFAULT 'sessions'      -- sessions | library | ingest
);

CREATE TABLE creators (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  platform_id TEXT,
  profile_url TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL DEFAULT 'local',      -- which collector machine
  host TEXT,
  mode TEXT,                                 -- fast | normal | train | unknown
  source_kind TEXT,                          -- reels_feed | saved | creator | mixed | unknown
  source_detail TEXT,                        -- JSON
  account TEXT,
  status TEXT NOT NULL,                      -- running | completed | interrupted | error
  started_at TEXT,
  ended_at TEXT,
  last_activity_at TEXT,
  duration_s REAL,
  stop_reason TEXT,
  incomplete INTEGER NOT NULL DEFAULT 0,
  incomplete_reason TEXT,
  recovered INTEGER NOT NULL DEFAULT 0,
  encountered INTEGER NOT NULL DEFAULT 0,
  downloaded INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  unavailable INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  bytes_downloaded INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT,
  resources_json TEXT,
  src_dir TEXT,
  imported_at TEXT,
  src_stamp TEXT
);
CREATE INDEX sessions_started ON sessions(started_at);

CREATE TABLE videos (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'instagram',
  platform_id TEXT,
  url TEXT,
  canonical_url TEXT,
  creator_id INTEGER REFERENCES creators(id),
  caption TEXT,
  hashtags TEXT,                             -- JSON array
  posted_at TEXT,
  first_collected_at TEXT,
  last_seen_at TEXT,
  source_kind TEXT,
  first_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  root_id INTEGER REFERENCES media_roots(id),
  rel_path TEXT,
  thumb_path TEXT,
  file_size INTEGER,
  duration_s REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  video_codec TEXT,
  audio_codec TEXT,
  has_audio INTEGER,
  sha256 TEXT,
  content_dup_of INTEGER REFERENCES videos(id),
  download_status TEXT NOT NULL DEFAULT 'discovered',
  file_missing INTEGER NOT NULL DEFAULT 0,
  analysis_status TEXT NOT NULL DEFAULT 'none',   -- none | queued | running | analysed | failed
  current_analysis_id INTEGER,
  cur_useful TEXT,                           -- useful | not_useful | uncertain
  cur_relevance REAL,
  cur_confidence REAL,
  cur_primary TEXT,
  cur_summary TEXT,
  bookmarked INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  source_info_json TEXT,
  provenance_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, platform_id)
);
CREATE INDEX videos_creator ON videos(creator_id);
CREATE INDEX videos_collected ON videos(first_collected_at);
CREATE INDEX videos_status ON videos(download_status, analysis_status);
CREATE INDEX videos_sha ON videos(sha256);
CREATE INDEX videos_bookmark ON videos(bookmarked) WHERE bookmarked = 1;
CREATE INDEX videos_size ON videos(file_size);
CREATE INDEX videos_duration ON videos(duration_s);
CREATE INDEX videos_relevance ON videos(cur_relevance);

CREATE TABLE session_videos (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position INTEGER,
  status TEXT NOT NULL,                      -- as recorded by the collector
  new_download INTEGER NOT NULL DEFAULT 0,   -- this session physically downloaded the file
  source_json TEXT,
  bytes INTEGER,
  attempts INTEGER,
  error TEXT,
  agent_decision_json TEXT,
  discovered_at TEXT,
  downloaded_at TEXT,
  PRIMARY KEY (session_id, video_id)
);
CREATE INDEX session_videos_video ON session_videos(video_id);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE video_tags (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL,
  PRIMARY KEY (video_id, tag_id)
);

CREATE TABLE analysis_batches (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  profile TEXT NOT NULL,
  selection_json TEXT NOT NULL,              -- exactly what the user asked for
  concurrency INTEGER NOT NULL DEFAULT 1,
  max_success INTEGER,
  max_cost_usd REAL,
  status TEXT NOT NULL DEFAULT 'queued',     -- queued | running | paused | completed | cancelled
  note TEXT
);

CREATE TABLE analyses (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  batch_id INTEGER REFERENCES analysis_batches(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT,
  profile TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL,                      -- queued | preparing | running | completed | failed | cancelled
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  result_json TEXT,
  raw_output TEXT,
  useful TEXT,
  relevance REAL,
  confidence REAL,
  summary TEXT,
  evidence_json TEXT,
  input_json TEXT,                           -- what the agent was actually given (frames, limits)
  usage_json TEXT,                           -- latency, tokens, cost where the provider reports them
  error TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  retry_of INTEGER REFERENCES analyses(id),
  claimed_by TEXT,                           -- host:pid of the runner executing it
  heartbeat_at TEXT
);
CREATE INDEX analyses_video ON analyses(video_id, created_at);
CREATE INDEX analyses_status ON analyses(status);
CREATE INDEX analyses_batch ON analyses(batch_id);

-- Classification labels. analysis_id NULL = human. A human row with status 'rejected' removes an agent label.
CREATE TABLE video_labels (
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  analysis_id INTEGER REFERENCES analyses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                        -- category | technique | observation
  key TEXT NOT NULL,
  confidence REAL,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',     -- active | rejected (human only)
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX video_labels_video ON video_labels(video_id);
CREATE INDEX video_labels_key ON video_labels(kind, key);

-- Denormalised "what we currently believe" per video, rebuilt from current analysis + human corrections.
CREATE TABLE video_current_labels (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  confidence REAL,
  source TEXT NOT NULL,                      -- agent | human
  PRIMARY KEY (video_id, kind, key)
);
CREATE INDEX vcl_key ON video_current_labels(kind, key);

CREATE TABLE corrections (
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_json TEXT,
  new_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE collectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE uploads (
  id INTEGER PRIMARY KEY,
  collector_id TEXT REFERENCES collectors(id),
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'partial',    -- partial | complete
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (sha256)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,                       -- ui | cli | mcp | collector:<id>
  action TEXT NOT NULL,
  detail_json TEXT
);
`
	}
];
