-- MVP additions: Google Business Profile columns
-- Note: provider_onboarding_sessions.step is a text column (Drizzle enum = TypeScript only),
-- so adding waba_check/waba_guide steps requires no DDL.

-- Google Business Profile columns on businesses (all nullable, no backfill)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS gmb_refresh_token text,
  ADD COLUMN IF NOT EXISTS gmb_location_id text,
  ADD COLUMN IF NOT EXISTS google_business_profile_url text;
