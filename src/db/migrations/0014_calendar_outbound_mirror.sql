-- Phase 2 (Calendar UX): outbound mirror linkage substrate.
-- Records the last Google etag the PA wrote for a booking's calendar event, so
-- inbound sync (Phase 3) can distinguish our own echo (incoming etag == last
-- written) from a genuine owner edit. See CALENDAR_UX_DESIGN.md §6 Phase 2.
-- Idempotent — safe to re-run.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS google_etag TEXT;
