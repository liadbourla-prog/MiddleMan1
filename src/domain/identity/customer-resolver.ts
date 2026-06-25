import { and, eq, ilike, desc } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, bookings, serviceTypes } from '../../db/schema.js'
import { isValidE164 } from './resolver.js'

export type TargetRole = 'customer' | 'contact'

export interface CandidateView {
  id: string
  displayName: string | null
  lastName: string | null
  phoneNumber: string
  lastBooking: { date: string; service: string | null } | null
}

export interface ResolveInput {
  role: TargetRole
  name?: string
  lastName?: string
  phoneNumber?: string
  timezone: string
  lang: 'he' | 'en'
}

export type CustomerResolution =
  | { status: 'resolved'; target: CandidateView }
  | { status: 'ambiguous'; query: string; candidates: CandidateView[] }
  | { status: 'not_found'; query: string }
  | { status: 'phone_unknown'; phoneNumber: string }

/** Last whitespace-delimited token of a name, or null for single-token/empty/nullish. */
export function deriveLastName(name: string | null | undefined): string | null {
  if (!name) return null
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 1]! : null
}
