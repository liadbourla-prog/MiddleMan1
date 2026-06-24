-- Subscriptions model + renewal-reminder anchor (Phase 4c).
-- See docs/superpowers/specs/2026-06-22-proactive-initiations-roadmap.md and the engine
-- design §8.3 "subscription renewal". Hand-applied (IF NOT EXISTS) — re-runs are safe.
-- Applied (with all migrations) by `npm run db:apply` (scripts/apply-all-migrations.ts);
-- see src/db/migrations/README.md.
--
-- A recurring service commitment per customer. There is NO external payment processor, so
-- this is informational + reminder-driving only (no auto-charge, no auto-advance): `renews_at`
-- is the scan anchor for the time-before subscription.renewal_{7d,1d} initiators, which remind
-- the customer ahead of the renewal date. The partial renews_at index keeps that daily scan
-- cheap by covering only the active rows.

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL REFERENCES identities(id),
  service_type_id uuid REFERENCES service_types(id),
  plan_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  interval_unit text NOT NULL,
  interval_count integer NOT NULL DEFAULT 1,
  renews_at timestamp with time zone NOT NULL,
  auto_renew boolean NOT NULL DEFAULT true,
  price_amount numeric(10, 2),
  price_currency text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  cancelled_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS subscriptions_business_status_idx
  ON subscriptions USING btree (business_id, status);

CREATE INDEX IF NOT EXISTS subscriptions_renews_at_idx
  ON subscriptions USING btree (renews_at) WHERE status = 'active';

-- Per-business opt-in for the renewal-reminder worker (default OFF, mirroring 0028's
-- proactive_winback_enabled). A dedicated boolean rather than an automated_messages_config
-- key, which would widen AutomatedMessagesConfig's keyof and break the skills config builder.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS subscription_renewal_enabled boolean NOT NULL DEFAULT false;
