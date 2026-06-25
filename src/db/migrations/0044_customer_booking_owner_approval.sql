-- Per-service owner approval of customer self-bookings (2026-06-25).
-- See docs/superpowers/specs/2026-06-25-customer-booking-owner-approval-design.md.
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- Opt-in, NEVER-default gate: when (and only when) the owner turns this on for a specific
-- service, a customer's Branch-4 self-booking for that service is HELD until the owner
-- confirms in Branch 3. All three columns are additive and backward-compatible — existing
-- rows get flag=false, status=NULL, window=24, so businesses that never ask see zero change.

-- Per-service opt-in flag (default OFF = today's behavior, never gated).
ALTER TABLE service_types ADD COLUMN IF NOT EXISTS requires_owner_approval boolean NOT NULL DEFAULT false;

-- Per-booking approval marker. NULL = a normal booking (today's behavior). Non-null only ever
-- set when the service had the flag on at request time. App-enforced enum ['pending','approved','declined'].
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS approval_status text;

-- Business-level approval window (hours). After this long with no owner decision, the held
-- request expires, the slot is released, and the customer is invited to rebook.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS booking_approval_window_hours integer NOT NULL DEFAULT 24;
