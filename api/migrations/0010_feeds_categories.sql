-- Feeds + categories (src/feeds.js). users.scope = the region scope every feed uses (funnygraph region key or 'global');
-- users.feed = the feed last chosen. categories = saved prompt feeds (filter JSON, src/feeds.js cleanFilter), public ones are
-- community categories others can follow. The ALTERs are not idempotent (duplicate column on a second run: harmless).
-- Apply once: npx wrangler d1 execute funnier --remote --file migrations/0010_feeds_categories.sql
CREATE TABLE IF NOT EXISTS categories (
  slug TEXT PRIMARY KEY,             -- [a-z0-9-]{3,40}
  title TEXT NOT NULL,
  prompt TEXT,                       -- what the user typed (<= 120 chars)
  filter TEXT NOT NULL,              -- cleanFilter JSON
  creator_id TEXT,                   -- NULL = curated
  public INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS categories_creator ON categories (creator_id);
CREATE TABLE IF NOT EXISTS category_follows (
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, slug)
);
CREATE INDEX IF NOT EXISTS category_follows_slug ON category_follows (slug);
ALTER TABLE users ADD COLUMN scope TEXT;
ALTER TABLE users ADD COLUMN feed TEXT;
