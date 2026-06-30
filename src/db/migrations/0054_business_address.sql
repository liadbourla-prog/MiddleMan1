-- Business physical location (2026-06-30).
-- The single canonical home for a business's address. Before this, an address only ever existed
-- transiently (GMB skill input, never persisted) or buried inside websiteJson — so Branch 4 could
-- not answer a customer's "where are you?" from facts, and the website/GMB skills each re-captured
-- it. These three columns fix that:
--   address            — canonical free-text display string, owner's language (e.g. 'הרצל 1, תל אביב').
--                        Surfaced verbatim to customers in Branch 4 via buildBusinessFacts.
--   address_components — structured jsonb { streetAddress, city, region, country, postalCode } (all
--                        optional) for the website builder and GMB listing.
--   google_maps_url    — the owner's pasted Google Maps / g.page link. When null, the app derives a
--                        Maps search URL from `address` (see src/domain/location/maps.ts), so there
--                        is always a link to give customers without storing a redundant field.
-- All set/changed conversationally by the owner in Branch 3 (manageBusinessSettings → business_profile).
-- All nullable — null until the owner provides an address, so existing businesses are unchanged.
--
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_components jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS google_maps_url text;
