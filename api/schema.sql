-- Funnier accounts (Cloudflare D1). Apply: wrangler d1 execute funnier --remote --file schema.sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  google_avatar TEXT,
  username TEXT UNIQUE COLLATE NOCASE,
  avatar_id TEXT,      -- legacy preset id (v1); superseded by avatar_seed
  avatar_seed TEXT,    -- seed the client renders a mascot avatar from (max 40, [A-Za-z0-9_-])
  birth_year INTEGER,
  country TEXT,
  sex_at_birth TEXT CHECK (sex_at_birth IS NULL OR sex_at_birth IN ('male', 'female', 'skip')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- one row per user per pair; a < b (sorted clip ids); the latest pick wins (upsert keeps the newest created_at)
CREATE TABLE IF NOT EXISTS votes (
  user_id TEXT NOT NULL,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  winner TEXT NOT NULL,
  why TEXT,
  ms INTEGER,
  daily TEXT,
  cc TEXT,
  created_at TEXT NOT NULL,
  -- signals TEXT is added by migrations/0004_watch_signals.sql (JSON watch signals, lexicon #signals)
  UNIQUE (user_id, a, b)
);
CREATE INDEX IF NOT EXISTS votes_pair ON votes (a, b);

-- friendship is stored both ways
CREATE TABLE IF NOT EXISTS friends (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  inviter_id TEXT NOT NULL,
  clash_a TEXT NOT NULL,
  clash_b TEXT NOT NULL,
  pick TEXT CHECK (pick IS NULL OR pick IN ('a', 'b')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS invites_inviter ON invites (inviter_id, created_at);

CREATE TABLE IF NOT EXISTS invite_opens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  opener_user_id TEXT,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  voted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invite_opens_code ON invite_opens (code);
CREATE INDEX IF NOT EXISTS invite_opens_opener ON invite_opens (opener_user_id);
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
