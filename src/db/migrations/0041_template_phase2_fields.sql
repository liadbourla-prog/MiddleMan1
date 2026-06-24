-- WhatsApp template catalog — Phase 2 (Tier 2) per-business toggles + scheduling fields.
-- See docs/superpowers/specs/2026-06-24-whatsapp-template-catalog-design.md §5 (#14–17).
-- Hand-authored, idempotent (IF NOT EXISTS) — re-runs are safe. Applied (with all
-- migrations) by `npm run db:apply` (scripts/apply-all-migrations.ts); see
-- src/db/migrations/README.md.
--
-- All new per-business toggles are dedicated boolean columns (mirroring
-- businesses.subscription_renewal_enabled) rather than automated_messages_config keys, so the
-- skills config builder's keyof stays narrow. Defaults preserve today's behavior:
--   reminder_offset_hours = 24  → unchanged 24h reminder
--   *_enabled             = false → opt-in features stay off until the owner turns them on.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS post_appointment_thankyou_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS reminder_offset_hours integer NOT NULL DEFAULT 24;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS periodic_treatment_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS birthday_greetings_enabled boolean NOT NULL DEFAULT false;

-- Per-service overrides (nullable → inherit business default / no periodic nudge).
ALTER TABLE service_types
  ADD COLUMN IF NOT EXISTS reminder_offset_hours integer;

ALTER TABLE service_types
  ADD COLUMN IF NOT EXISTS recommended_interval_days integer;
