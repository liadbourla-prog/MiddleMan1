-- Per-business booking authority (2026-06-25).
-- See docs/superpowers/specs/2026-06-25-cross-branch-consistency-and-booking-authority-design.md (§4.2).
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- Governs ONLY PA/owner-initiated bookings (decision D1): customer self-bookings are never
-- gated by this column.
--   'auto'           → PA books any open slot on the owner's behalf; owner is notified, not asked.
--   'owner_approval' → a PA/owner-initiated booking is held until the owner's explicit chat "yes".
-- Default 'auto' = today's behavior, so existing businesses are unchanged.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS booking_authority text NOT NULL DEFAULT 'auto';
