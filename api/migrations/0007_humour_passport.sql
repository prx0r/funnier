-- v6: the Humour Passport (funnier.humour/v1, src/passport.js): the owner's interpretable model, pushed from their
-- device, served at GET /u/<name>/humour.json when the profile is public. A re-run fails harmlessly (duplicate column).
-- Apply once: npx wrangler d1 execute funnier --remote --file migrations/0007_humour_passport.sql
ALTER TABLE profiles ADD COLUMN humour TEXT;
