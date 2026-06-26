-- Issue 3: block open time around classes with two visibility modes.
-- The owner can block the hours around existing classes EITHER as real "blocked time"
-- that mirrors out and is visible in their Google calendar (mirror_to_google = true),
-- OR as internal-only off-limits hours the customer engine still refuses but that never
-- clutter the owner's Google calendar (mirror_to_google = false). The mirror worker
-- (processBlockUpsert) skips false rows; Branch 4 honors both because availability reads
-- block rows by TYPE, not by visibility. See block-around-classes.ts / CALENDAR_UX_DESIGN.md.
--
-- Default true preserves the existing behavior for every block created before/elsewhere.
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Apply via `npm run db:apply`.

ALTER TABLE calendar_blocks
  ADD COLUMN IF NOT EXISTS mirror_to_google boolean NOT NULL DEFAULT true;
