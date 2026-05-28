-- Per-conversation pause: manager can silence the PA for one customer temporarily
ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS conversation_paused_until TIMESTAMPTZ;
