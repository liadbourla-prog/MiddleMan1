-- Per-business manager channel (2026-06-30).
-- See docs/superpowers/specs/2026-06-30-central-number-manager-channel.md.
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- Where the owner manages the PA (Branch 3):
--   'own_number' → the business's own dedicated PA number (today's behavior).
--   'central'    → the shared central MiddleMan number (PROVIDER_WA_NUMBER); customers
--                  (Branch 4) still reach the business on its own PA number.
-- Default 'own_number' = today's behavior, so existing businesses are unchanged.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS manager_channel text NOT NULL DEFAULT 'own_number';
