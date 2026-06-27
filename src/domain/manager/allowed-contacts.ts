import { isValidE164 } from '../identity/resolver.js'

export interface AllowedContact {
  phone: string // E.164
  label?: string
  addedAt: string // ISO8601
}

/** Add (or no-op if present) a contact. Throws on an invalid E.164 number. Pure. */
export function addAllowedContact(
  list: AllowedContact[] | null,
  phone: string,
  label: string | undefined,
  addedAtIso: string,
): AllowedContact[] {
  if (!isValidE164(phone)) {
    throw new Error(`Invalid phone number: "${phone}". Must be E.164 (e.g. +972501234567).`)
  }
  const current = list ?? []
  if (current.some((c) => c.phone === phone)) return current // idempotent
  const entry: AllowedContact = { phone, addedAt: addedAtIso }
  if (label) entry.label = label
  return [...current, entry]
}

/** Remove a contact by phone (no-op if absent). Pure. */
export function removeAllowedContact(list: AllowedContact[] | null, phone: string): AllowedContact[] {
  return (list ?? []).filter((c) => c.phone !== phone)
}

/** True iff phone is explicitly on the list. Pure. */
export function isAllowed(list: AllowedContact[] | null, phone: string): boolean {
  return (list ?? []).some((c) => c.phone === phone)
}
