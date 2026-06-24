-- Business-level quiet hours for proactive PROMOTIONAL initiations (Phase 5.2).
-- See docs/superpowers/specs/2026-06-22-proactive-initiations-roadmap.md (Phase 5.2) and
-- engine design §4.3 step 3. Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all
-- migrations) by `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- A jsonb { start: 'HH:MM', end: 'HH:MM' } window business-local; null = no quiet hours. The
-- initiation dispatcher computes nowInQuietHours from this + the business timezone for promotional
-- sends (the gate then skips them with reason 'quiet_hours'); transactional sends ignore it. Distinct
-- from reshuffle_config.quietHours, which the reshuffle engine keeps for its own campaign cadence.
-- The setter UX lands in Phase 5.5.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS quiet_hours jsonb;
