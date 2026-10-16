-- v5: public profiles (the "Letterboxd for comedy" identity layer): Four Favourites, pinned clips, the humour chart
-- snapshot (computed on the owner's device from their votes + theory.json), a specials diary, AI sets (later) and a
-- link-preview image. Idempotent (CREATE ... IF NOT EXISTS only).
-- Apply once: npx wrangler d1 execute funnier --remote --file migrations/0006_profiles.sql
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  favs TEXT,                       -- JSON array: up to 4 comic names (comics.json keys), in order
  pins TEXT,                       -- JSON array: up to 6 clip ids
  chart TEXT,                      -- JSON humour chart snapshot (dims 0..100, ops, sty, line, mml, adjacent, funniest)
  vis_profile TEXT NOT NULL DEFAULT 'public' CHECK (vis_profile IN ('public', 'friends', 'private')), -- favourites, pins, chart
  vis_diary TEXT NOT NULL DEFAULT 'friends' CHECK (vis_diary IN ('public', 'friends', 'private')),   -- specials log + notes
  og BLOB,                         -- 1200x630 PNG rendered by the owner's browser (link previews)
  og_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS specials_log (
  user_id TEXT NOT NULL,
  special_id TEXT NOT NULL,        -- comics.json specials[].id
  seen INTEGER NOT NULL DEFAULT 0,
  stars REAL,                      -- 0.5..5 in halves
  note TEXT,                       -- max 280
  at TEXT NOT NULL,                -- last edit (client clock, capped at now); the newest edit wins on sync
  PRIMARY KEY (user_id, special_id)
);
-- sets a user owns. Only kind = 'ai' (AI comedy sets they generate) is planned; nothing writes here yet.
CREATE TABLE IF NOT EXISTS sets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ai')),
  title TEXT,
  data TEXT,                       -- JSON
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'friends', 'private')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sets_user ON sets (user_id, created_at);
