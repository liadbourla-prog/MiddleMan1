-- WhatsApp template provisioning — per-WABA replication of the template catalog.
-- See docs/superpowers/specs/2026-06-24-whatsapp-template-catalog-design.md §3/§6.
-- Hand-authored, idempotent (IF NOT EXISTS) — re-runs are safe. Applied (with all
-- migrations) by `npm run db:apply` (scripts/apply-all-migrations.ts).
--
-- Templates are owned at the WABA level and each business has its own WABA (Embedded Signup),
-- so the catalog in src/adapters/whatsapp/templates.ts must be CREATED inside every business's
-- WABA. Two things this migration adds:
--   businesses.whatsapp_business_account_id — the WABA id (distinct from phone_number_id) that
--     the Graph API /{WABA}/message_templates create endpoint requires. Captured at onboarding.
--   wa_template_provisioning — one row per (business, template, language): tracks creation +
--     Meta review status so provisioning is idempotent and auditable.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS whatsapp_business_account_id text;

CREATE TABLE IF NOT EXISTS wa_template_provisioning (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id),
  template_name    text NOT NULL,
  language_code    text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','exists','error')),
  meta_template_id text,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One row per (business, template, language) → re-running provisioning upserts in place.
CREATE UNIQUE INDEX IF NOT EXISTS wa_template_provisioning_unique_idx
  ON wa_template_provisioning(business_id, template_name, language_code);
