import { isAllowed, type AllowedContact } from '../domain/manager/allowed-contacts.js'

/**
 * Contact-restriction gate decision (pure). Returns true iff this inbound must be silently dropped.
 * Off → never. On → manager/delegated_user/contact/provider always pass; customer/unknown pass only if listed.
 *
 * Extracted from webhook.ts so it can be unit-tested without importing the webhook module, which
 * pulls in db/client.js (throws at import time without DATABASE_URL) and the LLM adapters.
 */
export function isInboundBlocked(
  restrictionEnabled: boolean,
  allowedContacts: AllowedContact[] | null,
  fromNumber: string,
  role: 'manager' | 'delegated_user' | 'customer' | 'provider' | 'contact' | null,
): boolean {
  if (!restrictionEnabled) return false
  if (role === 'manager' || role === 'delegated_user' || role === 'contact' || role === 'provider') return false
  return !isAllowed(allowedContacts, fromNumber)
}
