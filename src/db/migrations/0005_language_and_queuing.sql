-- Business default language (Hebrew default, critical from day 1)
ALTER TABLE "businesses" ADD COLUMN "default_language" text NOT NULL DEFAULT 'he';

-- Per-customer language preference (set after language-switch offer)
ALTER TABLE "identities" ADD COLUMN "preferred_language" text;

-- Extend session state enum to support language-switch prompt
ALTER TABLE "conversation_sessions"
  DROP CONSTRAINT IF EXISTS conversation_sessions_state_check;

ALTER TABLE "conversation_sessions"
  ADD CONSTRAINT conversation_sessions_state_check
  CHECK (state IN ('active','waiting_confirmation','waiting_clarification','waiting_language_confirmation','completed','expired','failed'));
