-- v7: characters you train from scratch (their own humour model, same engine, same passport format) and immutable
-- model versions (snapshots of a passport: yours or a character's). Idempotent (CREATE ... IF NOT EXISTS only).
-- Apply once: npx wrangler d1 execute funnier --remote --file migrations/0008_characters_versions.sql
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,               -- client-made: c + 8..16 [a-z0-9]; stable URL /c/<id>
  owner_id TEXT NOT NULL,
  parent_id TEXT,                    -- forks / fine-tunes: the character this one started from
  parent_hash TEXT,                  -- the parent's passport hash at fork time (its model snapshot)
  name TEXT NOT NULL,
  bio TEXT,
  avatar_seed TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  passport TEXT,                     -- latest funnier.humour/v1 passport of the character's model (cleanPassport)
  social TEXT,                       -- reserved JSON: the character's own social accounts (later)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS characters_owner ON characters (owner_id, created_at);
CREATE INDEX IF NOT EXISTS characters_parent ON characters (parent_id);
CREATE TABLE IF NOT EXISTS model_versions (
  id TEXT PRIMARY KEY,               -- client-made: <hash>-<base36 time>
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,             -- 'me' or a character id the user owns
  hash TEXT NOT NULL,
  name TEXT,                         -- the computed type name at that moment
  votes INTEGER NOT NULL DEFAULT 0,
  passport TEXT NOT NULL,            -- the immutable passport artifact
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_versions_subject ON model_versions (user_id, subject, created_at);
