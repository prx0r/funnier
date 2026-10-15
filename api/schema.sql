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
