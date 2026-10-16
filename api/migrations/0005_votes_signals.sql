-- v4: JSON watch signals on each vote (lexicon #signals). Apply once; a re-run fails with "duplicate column" (harmless).
-- npx wrangler d1 execute funnier --remote --file migrations/0005_votes_signals.sql
ALTER TABLE votes ADD COLUMN signals TEXT;
