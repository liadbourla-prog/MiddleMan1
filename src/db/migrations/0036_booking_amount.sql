-- Booking price snapshot — pinned amount on bookings (Phase 3; engine design §0.3/§7.6).
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- The service price can change over time; this captures the price AT BOOKING TIME so
-- lifetime-spend / LTV (the value model's send-prioritization input) stays historically
-- accurate. Null = free service or a pre-Phase-3 historical booking (no backfill).

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount numeric(10, 2);
