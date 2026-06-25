-- True 24h-window source of truth (2026-06-25 fix for false "24h limit" claims).
-- The WhatsApp 24-hour customer-service window is keyed on a person's last INBOUND message.
-- It was previously inferred from conversation_sessions.last_message_at — a session-lifecycle
-- field that (a) is bumped forward by outbound/PA-only activity and (b) is NOT written by inbound
-- paths that return early (paused business, opt-out, coordination counterparties). That divergence
-- made canSendFreeForm report the window closed when it was open → the PA falsely told owners the
-- "24h limit" blocked a send. We now record last_inbound_at on every inbound and read THAT.
--
-- Hand-applied (IF NOT EXISTS / guarded) — re-runs are safe. Apply via `npm run db:apply`.

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;

-- Backfill from the most accurate signal we have for existing rows: the latest CUSTOMER-role
-- message in conversation_messages (a true inbound), joined to its session's identity. Going
-- forward the webhook writes last_inbound_at precisely; this only seeds the transition window so
-- currently-in-window customers aren't wrongly treated as out-of-window right after deploy.
-- Guarded by `last_inbound_at IS NULL` so re-runs never clobber values set by live traffic.
UPDATE identities i
SET last_inbound_at = sub.max_inbound
FROM (
  SELECT cs.identity_id, MAX(cm.created_at) AS max_inbound
  FROM conversation_messages cm
  JOIN conversation_sessions cs ON cs.id = cm.session_id
  WHERE cm.role = 'customer'
  GROUP BY cs.identity_id
) sub
WHERE i.id = sub.identity_id
  AND i.last_inbound_at IS NULL;
