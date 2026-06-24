-- Grow payments integration — Phase 1 (credential onboarding only; no sends yet).
-- See docs/superpowers/specs/2026-06-24-grow-payments-integration-design.md §6.
-- Hand-authored, idempotent (IF NOT EXISTS) — re-runs are safe. Applied (with all
-- migrations) by `npm run db:apply` (scripts/apply-all-migrations.ts); see
-- src/db/migrations/README.md.
--
-- Two tables only this phase:
--   business_payment_credentials — encrypted/at-rest per-business processor creds. The raw
--     Grow apiKey is NEVER stored here; api_key_ref holds the Secret Manager resource name.
--   payment_connect_tokens — one-time signed link for the credential-capture web form
--     (a clone of import_tokens: UUID secret, 30-min expiry, single-use).

CREATE TABLE IF NOT EXISTS business_payment_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id),
  provider          text NOT NULL DEFAULT 'grow',
  user_id           text NOT NULL,                 -- Grow userId (merchant id; at-rest encrypted by Cloud SQL)
  page_code         text NOT NULL,                 -- Grow pageCode
  api_key_ref       text NOT NULL,                 -- Secret Manager resource name (never the raw key)
  environment       text NOT NULL DEFAULT 'production' CHECK (environment IN ('sandbox','production')),
  webhook_token     text NOT NULL,                 -- unguessable path segment for notifyUrl
  webhook_secret    text NOT NULL,                 -- our own verification secret
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','invalid','revoked')),
  connected_at      timestamptz,
  last_validated_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per (business, provider). Connecting again updates that row in place.
CREATE UNIQUE INDEX IF NOT EXISTS business_payment_credentials_biz_provider_idx
  ON business_payment_credentials(business_id, provider);

-- Unguessable webhook path token must be unique so the Phase-2 webhook route can resolve
-- a single business from /payment-webhook/grow/{token}.
CREATE UNIQUE INDEX IF NOT EXISTS business_payment_credentials_webhook_token_idx
  ON business_payment_credentials(webhook_token);

CREATE TABLE IF NOT EXISTS payment_connect_tokens (
  token         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  manager_phone text NOT NULL,
  expires_at    timestamptz NOT NULL,              -- 30 min
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
