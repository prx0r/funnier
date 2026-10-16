-- Seen tracking (src/seen.js): one row per user per clip. Merged with max / or semantics (never goes backwards).
-- Apply once: npx wrangler d1 execute funnier --remote --file migrations/0009_watches.sql   (idempotent)
CREATE TABLE IF NOT EXISTS watches (
  user_id TEXT NOT NULL,
  clip_id TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  secs REAL NOT NULL DEFAULT 0,      -- seconds of real playback (max)
  max_pos REAL NOT NULL DEFAULT 0,   -- furthest position reached by real playback, seconds into the video
  frac REAL NOT NULL DEFAULT 0,      -- furthest fraction of the screened window watched, 0..1
  finished INTEGER NOT NULL DEFAULT 0, -- watched to its end (sticky): never served again in rotation
  shows INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  rewatches INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, clip_id)
);
CREATE INDEX IF NOT EXISTS watches_user_last ON watches (user_id, last_seen);
