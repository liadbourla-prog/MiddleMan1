-- Calendar blocks: time-ranged blocks, personal events, and proactively-scheduled
-- group sessions. Single home for "manager-occupied time", distinct from recurring
-- working hours (availability) and customer bookings (bookings).
-- See CALENDAR_UX_DESIGN.md. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS calendar_blocks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id),
  type             TEXT NOT NULL DEFAULT 'block',
  start_ts         TIMESTAMPTZ NOT NULL,
  end_ts           TIMESTAMPTZ NOT NULL,
  title            TEXT,
  reason           TEXT,
  service_type_id  UUID REFERENCES service_types(id),
  max_participants INTEGER,
  provider_id      UUID REFERENCES identities(id),
  google_event_id  TEXT,
  google_etag      TEXT,
  source           TEXT NOT NULL DEFAULT 'internal',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_blocks_business_range_idx
  ON calendar_blocks (business_id, start_ts, end_ts);

CREATE INDEX IF NOT EXISTS calendar_blocks_google_event_idx
  ON calendar_blocks (business_id, google_event_id);
