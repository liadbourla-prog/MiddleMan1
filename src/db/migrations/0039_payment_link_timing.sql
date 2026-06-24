-- Owner-configurable pay-link send timing (Grow Phase 3; design §3.1, §6 second SQL block).
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- The owner decides WHEN the first pay-link goes out relative to the appointment:
--   'at_booking' (default, today's behavior) → the link is sent as soon as the booking
--                 enters pending_payment.
--   'offset'     → payment_link_offset_minutes is the offset vs slot_start consumed by the
--                 payment-request worker (negative = before, positive = after; e.g. -1440 =
--                 24h before). Edited conversationally via the configurePaymentTiming Branch-3
--                 tool. NULL offset behaves like 'at_booking'.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payment_link_send_policy text NOT NULL DEFAULT 'at_booking'
  CHECK (payment_link_send_policy IN ('at_booking','offset'));
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payment_link_offset_minutes integer;
