-- v3: laugh button, learned clip durations, crowd "too loud / too quiet".
-- Apply once: npx wrangler d1 execute funnier --remote --file migrations/0003_laughs_durations_audio.sql  (idempotent)
CREATE TABLE IF NOT EXISTS laughs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clip TEXT NOT NULL,
  t_sec INTEGER NOT NULL,          -- whole second into the video when the viewer tapped Laugh
  user_or_device TEXT NOT NULL,    -- 'u:<user id>' when signed in, else 'd:<random device id>'
  created_at INTEGER NOT NULL      -- epoch ms
);
CREATE INDEX IF NOT EXISTS laughs_clip ON laughs (clip, t_sec);
CREATE INDEX IF NOT EXISTS laughs_who ON laughs (user_or_device, created_at);

-- durations reported by viewers' players (getDuration), so the catalogue learns lengths without any scraping
CREATE TABLE IF NOT EXISTS clip_durations (
  clip TEXT PRIMARY KEY,
  dur_sec REAL NOT NULL,
  reports INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- one "too loud" / "too quiet" per viewer per clip (latest wins)
CREATE TABLE IF NOT EXISTS clip_audio (
  clip TEXT NOT NULL,
  user_or_device TEXT NOT NULL,
  dir TEXT NOT NULL CHECK (dir IN ('loud', 'quiet')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (clip, user_or_device)
);
