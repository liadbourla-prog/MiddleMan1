-- P4: restore-after-cancel. Two customer_profiles columns holding a snapshot of the most
-- recently cancelled booking, so a follow-up "give me back the class we cancelled" can
-- re-offer the exact slot — even when the restore arrives in a fresh session (the cancel
-- session is completed and never reloaded).
--
--   last_cancelled_booking: jsonb { bookingId, serviceTypeId, serviceName, slotStartIso }
--   last_cancelled_at:      when the cancellation happened (drives a freshness window)
--
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Apply via `npm run db:apply`.

ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS last_cancelled_booking jsonb;

ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS last_cancelled_at timestamp with time zone;
