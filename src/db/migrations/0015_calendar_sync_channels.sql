-- Inbound sync (Phase 3): per-business Google Calendar watch-channel + incremental
-- sync state. One row per connected business. The watch channel is a push
-- subscription Google expires by time (renewal cron re-registers it); sync_token
-- drives incremental events.list with a full-reconcile fallback when null/expired.
-- See CALENDAR_UX_DESIGN.md §6 Phase 3. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS calendar_sync_channels (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id) UNIQUE,
  calendar_id         TEXT NOT NULL,
  channel_id          TEXT,
  resource_id         TEXT,
  channel_token       TEXT,
  channel_expiration  TIMESTAMPTZ,
  sync_token          TEXT,
  last_sync_at        TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active',
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_sync_channels_channel_idx
  ON calendar_sync_channels (channel_id);

CREATE INDEX IF NOT EXISTS calendar_sync_channels_resource_idx
  ON calendar_sync_channels (resource_id);
