-- Website builder columns on businesses
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS website_json JSONB,
  ADD COLUMN IF NOT EXISTS website_preview_url TEXT,
  ADD COLUMN IF NOT EXISTS website_url TEXT;
