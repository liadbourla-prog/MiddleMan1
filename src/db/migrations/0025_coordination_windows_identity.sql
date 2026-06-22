-- Round-1 meeting-coordination fixes. See docs/superpowers/specs/2026-06-22-meeting-coordination-fixes-design.md.
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Apply via scripts/apply-coordination-migration.ts.

-- Bug 1: business-level self-identification preference for outreach.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS outreach_identity_mode text
    CHECK (outreach_identity_mode IN ('business', 'owner_name'));

-- Bug 2: day/time-range boundaries for a coordination.
ALTER TABLE meeting_coordinations
  ADD COLUMN IF NOT EXISTS allowed_windows jsonb;
