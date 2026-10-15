-- v2 avatars: one seed per user instead of 12 preset ids.
-- Apply once: npx wrangler d1 execute funnier --remote --file migrations/0002_avatar_seed.sql
ALTER TABLE users ADD COLUMN avatar_seed TEXT;
UPDATE users SET avatar_seed = 'preset-' || avatar_id WHERE avatar_seed IS NULL AND avatar_id IS NOT NULL;
