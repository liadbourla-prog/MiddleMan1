-- Dynamic owner notification rules (Phase 5.5; engine design §7.7) — the voluntary-OAU control dial.
-- See docs/superpowers/specs/2026-06-22-proactive-initiations-roadmap.md (Phase 5.5). Hand-applied
-- (IF NOT EXISTS) — re-runs are safe. Applied (with all migrations) by `npm run db:apply`
-- (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- A jsonb array of { event, action, condition? } rules. The rules layer ADDITIVELY over the legacy
-- notification_preferences booleans (which remain the fallback): a matching rule wins, otherwise the
-- legacy boolean for that event applies, otherwise a safe default of 'notify'. Edited conversationally
-- via the configureNotifications Branch-3 tool; evaluated by resolveNotificationAction. null = no rules.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS notification_rules jsonb;
