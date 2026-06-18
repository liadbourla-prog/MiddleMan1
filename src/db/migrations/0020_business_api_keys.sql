-- Per-business API keys for the public website data API (website-data-plugin).
-- Only the sha256 hash is stored; the raw key is shown once at mint time.
-- Applied manually (this project's migrations are hand-applied). IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS business_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  type text NOT NULL,
  key_hash text NOT NULL,
  prefix text NOT NULL,
  label text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS business_api_keys_hash_idx ON business_api_keys (key_hash);
CREATE INDEX IF NOT EXISTS business_api_keys_business_idx ON business_api_keys (business_id, is_active);
