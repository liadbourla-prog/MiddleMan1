-- Chatbot upgrade: remove waiting_language_confirmation session state
-- Any sessions stuck in this state are expired so the new inline language switch takes over

UPDATE conversation_sessions
  SET state = 'expired'
  WHERE state = 'waiting_language_confirmation';
