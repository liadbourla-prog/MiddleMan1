-- Proactive Reshuffle Engine.
-- See docs/superpowers/plans/2026-06-18-proactive-reshuffle-engine.md
--
-- Applied manually (this project's migrations are hand-applied, not via
-- drizzle-kit migrate). IF NOT EXISTS / guarded ALTERs keep re-runs safe.

-- Owner-configurable knobs (null = safe defaults; domain/reshuffle/config.ts).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS reshuffle_config jsonb;

-- VIPs are never moved involuntarily (decision A4).
ALTER TABLE identities ADD COLUMN IF NOT EXISTS vip boolean NOT NULL DEFAULT false;

-- One per reschedule request the engine takes on.
CREATE TABLE IF NOT EXISTS reshuffle_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  requester_id uuid NOT NULL REFERENCES identities(id),
  requester_booking_id uuid NOT NULL REFERENCES bookings(id),
  service_type_id uuid NOT NULL REFERENCES service_types(id),
  target_slot_start timestamptz NOT NULL,
  target_slot_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'searching',
  strategy text,
  outreach_count integer NOT NULL DEFAULT 0,
  config_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS reshuffle_campaigns_status_idx
  ON reshuffle_campaigns (business_id, status);

-- One per "we asked customer X whether they'll take slot Y".
CREATE TABLE IF NOT EXISTS reshuffle_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES reshuffle_campaigns(id),
  customer_id uuid NOT NULL REFERENCES identities(id),
  booking_id uuid REFERENCES bookings(id),
  proposed_slot_start timestamptz NOT NULL,
  proposed_slot_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'probing',
  counter_slot_start timestamptz,
  counter_slot_end timestamptz,
  offered_at timestamptz NOT NULL DEFAULT now(),
  offer_expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS reshuffle_offers_campaign_idx
  ON reshuffle_offers (campaign_id, status);

-- The assembled solution presented to the owner (the approval gate's persisted state).
CREATE TABLE IF NOT EXISTS reshuffle_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES reshuffle_campaigns(id),
  moves jsonb NOT NULL,
  touched_count integer NOT NULL,
  kind text NOT NULL DEFAULT 'exact',
  status text NOT NULL DEFAULT 'pending',
  amended_from_id uuid,
  presented_to_owner_at timestamptz,
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS reshuffle_proposals_campaign_idx
  ON reshuffle_proposals (campaign_id, status);

-- Cyclic apply (decision G-4): applying a cycle of reassignments transiently collides
-- with any per-(provider,slot) uniqueness. If such a constraint exists it must be checked
-- at COMMIT, not per-statement. No-op here unless a matching constraint is present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bookings_provider_slot_unique'
  ) THEN
    ALTER TABLE bookings ALTER CONSTRAINT bookings_provider_slot_unique DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
