-- Owner-approval gate for freed-slot waitlist offers (WS-C / #6 / #8).
-- See CALENDAR_BULLETPROOFING_PLAN.md.
--
-- Applied manually (this project's migrations are hand-applied, not via
-- drizzle-kit migrate). IF NOT EXISTS / guarded ALTERs keep re-runs safe.

-- Standing per-business preference. NULL = owner has never been asked → the first freed
-- slot asks AND offers to make it automatic. 'ask' = ask each time · 'auto' = auto-offer ·
-- 'never' = never offer. No DEFAULT on purpose: NULL is the meaningful "unset" state.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS freed_slot_offer_policy text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE constraint_name = 'businesses_freed_slot_offer_policy_check'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_freed_slot_offer_policy_check
      CHECK (freed_slot_offer_policy IN ('ask', 'auto', 'never'));
  END IF;
END $$;

-- One per freed slot waiting on owner approval before the waitlist offer goes out.
CREATE TABLE IF NOT EXISTS freed_slot_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  service_type_id uuid NOT NULL REFERENCES service_types(id),
  slot_start timestamptz NOT NULL,
  slot_end timestamptz NOT NULL,
  source_booking_id uuid REFERENCES bookings(id),
  candidate_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS freed_slot_approvals_pending_idx
  ON freed_slot_approvals (business_id, status);
CREATE INDEX IF NOT EXISTS freed_slot_approvals_slot_idx
  ON freed_slot_approvals (business_id, slot_start);
