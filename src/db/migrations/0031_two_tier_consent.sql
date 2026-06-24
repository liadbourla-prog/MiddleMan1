-- Two-tier consent — per-category promotional opt-out on identities (Phase 5.1).
-- See docs/superpowers/specs/2026-06-22-proactive-initiations-roadmap.md (Phase 5.1) and
-- engine design §7. Hand-applied (IF NOT EXISTS) — re-runs are safe. Applied (with all
-- migrations) by `npm run db:apply` (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- identities.messaging_opt_out remains the GLOBAL kill-switch (set by the Meta platform
-- opt-out) and suppresses everything. This new jsonb is the per-category PROMOTIONAL
-- opt-out: a map of consent-category → true. Transactional sends ignore it; the dispatcher
-- consults it for promotional customer/contact sends. The setter UX lands in Phase 5.5.

ALTER TABLE identities ADD COLUMN IF NOT EXISTS promotional_opt_outs jsonb;
