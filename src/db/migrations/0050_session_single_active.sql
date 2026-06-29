-- T1.8d / B4 (WS1 write-integrity) — at most ONE non-terminal session per identity.
--
-- Finding B4 (HIGH): `loadActiveSession` bound to the OLDEST open session (orderBy createdAt
-- ASC). If two non-terminal sessions ever coexisted for one identity (from a B1/B3 race, or
-- a concurrent unlocked createSession), every later turn read history from one row while new
-- messages landed in another → "the PA forgot the last few turns." The code fix orders newest-
-- first; THIS migration is the DB backstop that makes a second non-terminal session impossible.
--
-- MIGRATION DISCIPLINE (§A2): runs AFTER 0049 (one migration committed before the next). The
-- backfill below reconciles any pre-existing duplicate non-terminal sessions FIRST (existing
-- duplicates would otherwise fail the unique index build), then adds the index. Trivial now
-- (no business provisioned) but written correctly.

-- (1) Backfill: collapse duplicate non-terminal sessions per identity, keeping the NEWEST
--     (greatest created_at, id tiebreak) and expiring the rest. Naturally idempotent — after
--     the first run each identity has ≤1 non-terminal session, so the predicate matches none.
UPDATE conversation_sessions s
SET state = 'expired'
WHERE s.state IN ('active', 'waiting_confirmation', 'waiting_clarification')
  AND EXISTS (
    SELECT 1 FROM conversation_sessions o
    WHERE o.identity_id = s.identity_id
      AND o.id <> s.id
      AND o.state IN ('active', 'waiting_confirmation', 'waiting_clarification')
      AND (o.created_at > s.created_at OR (o.created_at = s.created_at AND o.id > s.id))
  );

-- (2) Partial unique index: ≤1 non-terminal session per identity. Idempotent via IF NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_sessions_one_active_idx
  ON conversation_sessions (identity_id)
  WHERE state IN ('active', 'waiting_confirmation', 'waiting_clarification');
