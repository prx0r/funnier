-- watch_events gains kind 'unplayable' (a clip whose YouTube embed failed or stalled on a device; the client swaps it on
-- the site and reports it; tally -> data/unplayable.json). SQLite can't alter a CHECK, so the table is rebuilt in place.
-- user_id is a user id, or 'd:<device id>' for anonymous unplayable reports.
CREATE TABLE IF NOT EXISTS watch_events_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skip', 'pass', 'unplayable')),
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  stage TEXT,
  clip TEXT,
  watched_sec INTEGER,
  ms INTEGER,
  daily TEXT,
  signals TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, kind, a, b, created_at)
);
INSERT OR IGNORE INTO watch_events_v2 (id, user_id, kind, a, b, stage, clip, watched_sec, ms, daily, signals, created_at)
  SELECT id, user_id, kind, a, b, stage, clip, watched_sec, ms, daily, signals, created_at FROM watch_events;
DROP TABLE watch_events;
ALTER TABLE watch_events_v2 RENAME TO watch_events;
CREATE INDEX IF NOT EXISTS watch_events_user ON watch_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS watch_events_clip ON watch_events (clip);
