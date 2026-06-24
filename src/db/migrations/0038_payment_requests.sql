-- Grow payments integration — Phase 2 (the charge ledger).
-- See docs/superpowers/specs/2026-06-24-grow-payments-integration-design.md §6, §7.
-- Hand-authored, idempotent (IF NOT EXISTS). Applied by `npm run db:apply`
-- (scripts/apply-all-migrations.ts); see src/db/migrations/README.md.
--
-- One row per charge we created. Backs idempotency (the unique transaction_code index),
-- webhook reconciliation, and audit. No secret material is ever stored here.

CREATE TABLE IF NOT EXISTS payment_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id),
  booking_id       uuid REFERENCES bookings(id),       -- null for ad-hoc (Case B w/o booking)
  customer_id      uuid REFERENCES identities(id),
  amount           numeric(10,2) NOT NULL,
  currency         text NOT NULL DEFAULT 'ILS',
  description      text NOT NULL,
  source           text NOT NULL CHECK (source IN ('booking','owner_command','dunning','subscription')),
  grow_process_id  text,
  payment_url      text,
  status           text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','expired','refunded')),
  transaction_code text,                                -- from webhook; idempotency key
  invoice_number   text,
  invoice_url      text,
  dedup_key        text NOT NULL,                       -- cross-initiator dedup (incl. time bucket)
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Idempotency guard: a Grow success webhook is processed exactly once per transaction_code.
CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_txn_idx
  ON payment_requests(transaction_code) WHERE transaction_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_requests_booking_idx ON payment_requests(booking_id);
