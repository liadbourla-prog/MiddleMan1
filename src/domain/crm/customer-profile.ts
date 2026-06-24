// Customer behavioral profile — PURE derivation over a customer's bookings. No I/O.
// The segment repository (segment-repository.ts) fetches rows and applies these; cold-fill
// targeting (Phase 3), win-back (Phase 4) and value scoring (Phase 5/6) all read the result.
// Mirrors the pure-core discipline of coordination/state.ts and initiations/gate.ts.

// Booking states that represent a real scheduled commitment (a "visit" for rhythm/recency).
// Excludes inquiry/requested/held/pending_payment/cancelled/expired/failed.
const VISIT_STATES = new Set(['confirmed', 'attended', 'no_show'])

export interface ProfileBooking {
  slotStart: Date
  state: string
  serviceTypeId: string
}

export type TimeBand = 'morning' | 'afternoon' | 'evening'

export interface CustomerProfile {
  lifetimeBookings: number // count of visit-state bookings
  attendedCount: number
  noShowCount: number
  noShowRate: number // noShow / (attended + noShow); 0 when none completed
  lastBookingAt: Date | null // most recent visit slotStart
  cadenceDays: number | null // median gap (days) between consecutive visits; null if <2 visits
  serviceTypeIds: string[] // distinct services across visits (for segment membership)
  preferredServiceTypeId: string | null // most-booked service
  preferredDayOfWeek: number | null // 0=Sun..6=Sat, business-local, modal
  preferredTimeBand: TimeBand | null // modal local time band
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function localDowAndBand(d: Date, timezone: string): { dow: number; band: TimeBand } {
  const wk = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(d)
  const dow = Math.max(0, DOW.indexOf(wk))
  const hourStr = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(d)
  const hour = parseInt(hourStr, 10) || 0
  const band: TimeBand = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
  return { dow, band }
}

function median(sorted: number[]): number {
  const n = sorted.length
  if (n === 0) return 0
  const mid = Math.floor(n / 2)
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function modal<T>(values: T[]): T | null {
  if (values.length === 0) return null
  const counts = new Map<T, number>()
  let best: T = values[0]!
  let bestN = 0
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1
    counts.set(v, n)
    if (n > bestN) {
      bestN = n
      best = v
    }
  }
  return best
}

/** Derive a behavioral profile from a customer's bookings. Pure; `now` is unused today but
 *  kept in the signature so lapsed/recency logic can extend without a breaking change. */
export function computeCustomerProfile(bookings: ProfileBooking[], timezone: string): CustomerProfile {
  const visits = bookings
    .filter((b) => VISIT_STATES.has(b.state))
    .sort((a, b) => a.slotStart.getTime() - b.slotStart.getTime())

  const attendedCount = bookings.filter((b) => b.state === 'attended').length
  const noShowCount = bookings.filter((b) => b.state === 'no_show').length
  const completed = attendedCount + noShowCount
  const noShowRate = completed > 0 ? noShowCount / completed : 0

  const lastBookingAt = visits.length > 0 ? visits[visits.length - 1]!.slotStart : null

  let cadenceDays: number | null = null
  if (visits.length >= 2) {
    const gaps: number[] = []
    for (let i = 1; i < visits.length; i++) {
      gaps.push((visits[i]!.slotStart.getTime() - visits[i - 1]!.slotStart.getTime()) / 86_400_000)
    }
    gaps.sort((a, b) => a - b)
    cadenceDays = Math.round(median(gaps))
  }

  const serviceTypeIds = [...new Set(visits.map((v) => v.serviceTypeId))]
  const preferredServiceTypeId = modal(visits.map((v) => v.serviceTypeId))

  const local = visits.map((v) => localDowAndBand(v.slotStart, timezone))
  const preferredDayOfWeek = local.length > 0 ? modal(local.map((l) => l.dow)) : null
  const preferredTimeBand = local.length > 0 ? modal(local.map((l) => l.band)) : null

  return {
    lifetimeBookings: visits.length,
    attendedCount,
    noShowCount,
    noShowRate,
    lastBookingAt,
    cadenceDays,
    serviceTypeIds,
    preferredServiceTypeId,
    preferredDayOfWeek,
    preferredTimeBand,
  }
}

/** A customer is "lapsed" when they have an established rhythm and have now overshot it. */
export function isLapsed(profile: CustomerProfile, now: Date, slack = 1.5): boolean {
  if (!profile.lastBookingAt || profile.cadenceDays == null || profile.cadenceDays <= 0) return false
  const sinceDays = (now.getTime() - profile.lastBookingAt.getTime()) / 86_400_000
  return sinceDays > profile.cadenceDays * slack
}

export interface SegmentMatchFilter {
  serviceTypeId?: string
  inactiveSinceDays?: number
  hasBooking?: boolean
  preferredDayOfWeek?: number
  preferredTimeBand?: TimeBand
  lapsed?: boolean
}

/** Booking-derived segment membership test. Identity-level facts (e.g. VIP) are filtered by
 *  the repository, which holds the identity row. Pure. */
export function matchesSegment(profile: CustomerProfile, filter: SegmentMatchFilter, now: Date): boolean {
  if (filter.hasBooking !== undefined) {
    if (filter.hasBooking !== profile.lifetimeBookings > 0) return false
  }
  if (filter.serviceTypeId && !profile.serviceTypeIds.includes(filter.serviceTypeId)) return false
  if (filter.inactiveSinceDays !== undefined) {
    if (!profile.lastBookingAt) return false
    const sinceDays = (now.getTime() - profile.lastBookingAt.getTime()) / 86_400_000
    if (sinceDays < filter.inactiveSinceDays) return false
  }
  if (filter.preferredDayOfWeek !== undefined && profile.preferredDayOfWeek !== filter.preferredDayOfWeek) return false
  if (filter.preferredTimeBand !== undefined && profile.preferredTimeBand !== filter.preferredTimeBand) return false
  if (filter.lapsed !== undefined && filter.lapsed !== isLapsed(profile, now)) return false
  return true
}
