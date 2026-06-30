-- Addressee grammatical gender (2026-06-30).
-- Hebrew conjugates second-person verbs/adjectives by the addressee's gender, but the PA
-- previously addressed everyone in masculine singular (the ADDRESSING rule in voice.ts). These
-- two columns let the system resolve and persist each person's gender so Branches 1–4 + the
-- proactive/worker sends address male and female correctly in Hebrew.
--   addressee_gender         — 'male' | 'female'. null = unknown → the masculine floor is used,
--                              but a guess is NEVER written (unknown stays unknown so a later,
--                              higher-confidence signal can still win).
--   addressee_gender_source  — provenance for precedence on overwrite:
--                              'explicit' > 'self_morphology' > 'name' > 'default'. A weaker
--                              signal never downgrades a stronger stored one (owner setCustomerGender
--                              sticks; a customer's own Hebrew corrects a first-name guess).
-- Distinct from businesses.bot_persona, which governs how the PA refers to ITSELF, not how it
-- addresses the person. Both nullable — null until a signal resolves, so existing identities are
-- unchanged and NO backfill is needed.
--
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.

ALTER TABLE identities ADD COLUMN IF NOT EXISTS addressee_gender text;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS addressee_gender_source text;
