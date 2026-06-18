-- CRM Tier-A: per-service named price tiers (CRM_STANDARD.md §1.2 / §4).
-- The service base price stays on service_types.payment_amount (the drop-in/default
-- rate); tiers express alternatives (e.g. 'member'). Eligibility is Tier-B; a tier
-- only resolves when a caller names it.
--
-- Applied manually (this project's migrations are hand-applied, not via
-- drizzle-kit migrate). IF NOT EXISTS guards keep re-runs safe.

CREATE TABLE IF NOT EXISTS service_price_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  service_type_id uuid NOT NULL REFERENCES service_types(id),
  tier text NOT NULL,
  amount numeric(10, 2) NOT NULL,
  currency text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS service_price_tiers_service_tier_idx
  ON service_price_tiers (service_type_id, tier);
