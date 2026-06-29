-- T1.1b (WS1 write-integrity) — DB-level overlap exclusion for exclusive (1-on-1) bookings.
--
-- Finding A1 (CRITICAL): private/appointment bookings had no DB backstop for the
-- partial-overlap race (14:00–15:00 vs 14:30–15:30 take different advisory-lock keys and
-- both commit → double-book). T1.1a's per-slotStart advisory lock closes the exact-same-slot
-- race but NOT the partial overlap. This migration adds the DB-level invariant that actually
-- expresses "an exclusive booking owns its time range on a given business."
--
-- DESIGN (the G1 trap, §v2-B): the discriminator that distinguishes a 1-on-1 booking from a
-- class co-booking (maxParticipants / scheduling_mode) lives on service_types, NOT bookings.
-- A naive EXCLUDE over all bookings would reject legitimate multi-seat class co-bookings at
-- the same slot → G1 regression. So we DENORMALIZE an `is_exclusive` boolean onto bookings,
-- set at insert (private/appointment ⇒ true; class ⇒ false), and scope the constraint to
-- `is_exclusive` rows only. Class rows (is_exclusive=false) are never constrained — multiple
-- confirmed class bookings at one slot remain legal.
--
-- MIGRATION DISCIPLINE (§A2): tables are near-empty (no business provisioned), so the backfill
-- is trivial — but it is written correctly anyway: (1) reconcile is_exclusive from the service's
-- scheduling_mode, (2) resolve any pre-existing exclusive overlaps (keep earliest-created, fail
-- the rest) so the constraint build cannot fail on legacy data, (3) add the constraint.
-- NOTE: Postgres EXCLUDE constraints do NOT support `NOT VALID` / `VALIDATE` (that pattern is
-- CHECK/FK-only — an exclusion constraint is index-backed and validates at build time). The
-- safe equivalent here is "backfill-clean first, then add" — which on a near-empty table is a
-- zero-row index build. This is the documented deviation from §A2's "NOT VALID → VALIDATE".

-- (1) btree_gist gives us `=` (uuid) inside a GiST index alongside the range `&&` operator.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- (2) Denormalized exclusivity flag. Default true is the safe/conservative choice (an unknown
--     booking blocks rather than risks a double-book); the engine sets it explicitly per path
--     and the backfill below corrects existing class rows to false.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_exclusive boolean NOT NULL DEFAULT true;

-- (3) Backfill is_exclusive from the service's scheduling mode: class ⇒ false, everything else
--     (appointment / NULL-mode malformed rows) ⇒ true (exclusive). Naturally idempotent.
UPDATE bookings b
SET is_exclusive = (st.scheduling_mode IS DISTINCT FROM 'class')
FROM service_types st
WHERE st.id = b.service_type_id
  AND b.is_exclusive <> (st.scheduling_mode IS DISTINCT FROM 'class');

-- (4) Reconcile any pre-existing exclusive overlaps so the constraint build cannot fail.
--     Keep the earliest-created booking in each overlap pair; mark the later one 'failed'.
--     Naturally idempotent: after the first run no overlapping active exclusive pair remains,
--     so the predicate matches zero rows on re-run.
UPDATE bookings b
SET state = 'failed', updated_at = now()
WHERE b.is_exclusive
  AND b.state IN ('held', 'pending_payment', 'confirmed')
  AND EXISTS (
    SELECT 1 FROM bookings o
    WHERE o.business_id = b.business_id
      AND o.id <> b.id
      AND o.is_exclusive
      AND o.state IN ('held', 'pending_payment', 'confirmed')
      AND tstzrange(o.slot_start, o.slot_end, '[)') && tstzrange(b.slot_start, b.slot_end, '[)')
      AND (o.created_at < b.created_at OR (o.created_at = b.created_at AND o.id < b.id))
  );

-- (5) The DB-level overlap invariant. Idempotent on re-run via the applier's duplicate-object
--     swallow (42710 / 42P07) — Postgres has no ADD CONSTRAINT IF NOT EXISTS.
ALTER TABLE bookings ADD CONSTRAINT bookings_exclusive_no_overlap
  EXCLUDE USING gist (
    business_id WITH =,
    tstzrange(slot_start, slot_end, '[)') WITH &&
  ) WHERE (is_exclusive AND state IN ('held', 'pending_payment', 'confirmed'));
