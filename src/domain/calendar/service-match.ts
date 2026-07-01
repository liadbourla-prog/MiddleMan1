/**
 * T1.1 — title→service matcher for the Google inbound translator.
 *
 * Google is an inbound *translator*, never a source of truth. The FIRST thing the
 * translator must decide about an owner-added event is: does its title name a
 * service this business actually offers? Only a match can ever become a bookable
 * class; anything else stays an opaque busy-block whose title is discarded. This
 * null-on-no-match IS the privacy gate that preserves decision #10 — a personal
 * "dentist"/"lunch" event never becomes a class because its title never matches a
 * defined service name.
 *
 * Deterministic only (no fuzzy / edit-distance — deferred): a title matches a
 * service iff, after normalization, the title EQUALS the service name or CONTAINS
 * it as a whole-token subsequence (so "פילאטיס ערב" / "Pilates class" match the
 * "Pilates" service, but "yogalates" does NOT match "yoga"). When several services
 * match, the longest (most specific) name wins.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { serviceTypes } from '../../db/schema.js'

export interface ServiceMatch {
  serviceTypeId: string
  schedulingMode: 'appointment' | 'class'
  /** The service's default capacity (service_types.maxParticipants). */
  defaultCapacity: number
  /** The service's class duration in minutes (service_types.durationMinutes), or null if unknown. */
  classDurationMinutes: number | null
}

/**
 * Normalize a title/service name for exact-normalized matching:
 *  - Unicode NFKD + strip Hebrew niqqud/cantillation (U+0591–U+05C7) so "פִּילָאטִיס" ≡ "פילאטיס"
 *  - lowercase, strip punctuation to spaces, collapse/trim whitespace
 * Returns '' for a blank/absent title (which never matches any service name).
 */
export function normalizeServiceTitle(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .normalize('NFKD')
    .replace(/[֑-ׇ]/g, '') // Hebrew niqqud + cantillation marks
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation → space (Unicode-aware)
    .replace(/\s+/g, ' ')
    .trim()
}

/** True iff `needle` (a normalized service name) appears in `haystack` as a whole-token subsequence. */
function containsAsTokens(haystack: string, needle: string): boolean {
  if (!needle) return false
  if (haystack === needle) return true
  const hTokens = haystack.split(' ')
  const nTokens = needle.split(' ')
  if (nTokens.length === 0 || nTokens.length > hTokens.length) return false
  for (let i = 0; i + nTokens.length <= hTokens.length; i++) {
    let ok = true
    for (let j = 0; j < nTokens.length; j++) {
      if (hTokens[i + j] !== nTokens[j]) { ok = false; break }
    }
    if (ok) return true
  }
  return false
}

/**
 * Match an owner event's title against the business's active service names. Returns
 * the matched service (id + scheduling mode + default capacity), or null on any
 * non-service title (the privacy gate). Longest-name-wins on multiple matches.
 */
export async function matchTitleToService(
  db: Db,
  businessId: string,
  summary: string | null | undefined,
): Promise<ServiceMatch | null> {
  const normTitle = normalizeServiceTitle(summary)
  if (!normTitle) return null

  const services = await db
    .select({
      id: serviceTypes.id,
      name: serviceTypes.name,
      schedulingMode: serviceTypes.schedulingMode,
      maxParticipants: serviceTypes.maxParticipants,
      durationMinutes: serviceTypes.durationMinutes,
      isActive: serviceTypes.isActive,
    })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.isActive, true)))

  let best: ServiceMatch | null = null
  let bestLen = -1
  for (const s of services) {
    const normName = normalizeServiceTitle(s.name as string)
    if (!normName) continue
    if (containsAsTokens(normTitle, normName) && normName.length > bestLen) {
      best = {
        serviceTypeId: s.id as string,
        schedulingMode: (s.schedulingMode as 'appointment' | 'class') ?? 'appointment',
        defaultCapacity: (s.maxParticipants as number) ?? 1,
        classDurationMinutes: (s.durationMinutes as number | null | undefined) ?? null,
      }
      bestLen = normName.length
    }
  }
  return best
}
