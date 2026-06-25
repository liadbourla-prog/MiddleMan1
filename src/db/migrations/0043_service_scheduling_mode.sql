-- Per-service scheduling mode (2026-06-25).
-- See BRANCH_3_4_BUGFIX_PLAN.md (Bug E).
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by
-- `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- Distinguishes how a service is booked:
--   'appointment' → private/open-time booking: any open slot within hours is bookable
--                   (today's behavior for every service).
--   'class'       → schedule-driven: bookable ONLY into scheduled class instances
--                   (calendar_blocks type='class'). A time with no class is refused and the
--                   real class times are offered. Set automatically by scheduleRecurringClasses.
-- Default 'appointment' = today's behavior, so existing services are unchanged.

ALTER TABLE service_types ADD COLUMN IF NOT EXISTS scheduling_mode text NOT NULL DEFAULT 'appointment';
