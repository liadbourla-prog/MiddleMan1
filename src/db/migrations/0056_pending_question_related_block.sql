-- Inbound translator T1.3 — pending-imported-class confirmation (2026-07-01).
-- When a customer asks about an UNCERTAIN owner-imported class (occupied but not yet
-- confirmed open), we relay to the owner via the existing pending_owner_questions spine.
-- This column links that pending question to the specific pending-class calendar_block, so
-- that when the owner confirms the class (materialize block→class), the exact waiting
-- customer(s) can be re-notified. Nullable — a plain owner-question relay leaves it null,
-- so existing rows and the customer-question path are unchanged.
--
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.

ALTER TABLE pending_owner_questions ADD COLUMN IF NOT EXISTS related_block_id uuid;
