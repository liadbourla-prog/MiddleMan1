-- Contact restriction (allowlist) + per-event notification digest queue.
--
-- (1) Two `businesses` columns backing the phone-number allowlist. Default OFF — behavior is
--     identical to today until the owner opts in via the manageAllowedContacts Branch-3 tool.
--     When ON, only numbers in allowed_contacts (plus manager/delegated/contact identities)
--     reach the PA; everyone else is silently dropped and the owner is forwarded the attempt.
--     allowed_contacts is a jsonb array of { phone: E164, label?: string, addedAt: ISO8601 }.
--
-- (2) notification_digest_queue: per-event owner-notification digest buffer. When a notification
--     rule routes an event to action 'digest', the owner emitter enqueues a row here instead of
--     sending immediately; the daily-briefing worker flushes unflushed rows and stamps flushed_at.
--
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Apply via `npm run db:apply`.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS contact_restriction_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS allowed_contacts jsonb;

CREATE TABLE IF NOT EXISTS notification_digest_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL REFERENCES businesses(id),
  event text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  flushed_at timestamp with time zone
);
