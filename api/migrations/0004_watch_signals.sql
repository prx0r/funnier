-- v4 (characters2 integration §3a/§3b): watch signals ride with each vote; skips/passes become watch events;
-- per-user humour profiles are written offline (tools/humour.mjs) and read by GET /me/humour.
-- Apply once: npx wrangler d1 execute funnier --remote --file migrations/0004_watch_signals.sql
-- Idempotent. The votes.signals column is added by 0005_votes_signals.sql (an ALTER, kept apart so its
-- "duplicate column" error on a re-run can't roll these back).
CREATE TABLE IF NOT EXISTS watch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skip', 'pass')),
  a TEXT NOT NULL,                 -- the clash as shown: a = clip one, b = clip two
  b TEXT NOT NULL,
  stage TEXT,                      -- intro | left | right | vote | left-skip | right-skip
  clip TEXT,                       -- the clip on screen when it was skipped (null for a pass)
  watched_sec INTEGER,
  ms INTEGER,
  daily TEXT,
  signals TEXT,                    -- JSON, same shape as votes.signals (lexicon #signals)
  created_at TEXT NOT NULL,
  UNIQUE (user_id, kind, a, b, created_at)
);
CREATE INDEX IF NOT EXISTS watch_events_user ON watch_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS watch_events_clip ON watch_events (clip);
CREATE TABLE IF NOT EXISTS humour_profiles (
  user_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,           -- JSON: { n, weights, top, line, updated }
  updated_at TEXT NOT NULL
);
