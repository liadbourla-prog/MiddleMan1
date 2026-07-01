export interface CalendarSlot {
  start: Date
  end: Date
}

export type AvailabilityResult =
  | { status: 'available' }
  | { status: 'occupied' }
  | { status: 'error'; reason: string }

export type HoldResult =
  | { status: 'held'; eventId: string; etag?: string | null }
  | { status: 'conflict' }
  | { status: 'error'; reason: string }

export interface PlaceHoldOptions {
  // When true, placeHold creates the hold WITHOUT a prior availability/freebusy probe.
  // Used for group-class bookings: a class instance is its own (mirrored) calendar
  // event, so a freebusy probe reports the slot busy and would falsely reject the first
  // booking into the class. Per-instance capacity is enforced authoritatively by the
  // booking engine (advisory-lock + count), so the probe is both wrong and redundant here.
  skipConflictCheck?: boolean
}

export type ConfirmResult =
  | { status: 'confirmed'; eventId: string; etag?: string | null }
  | { status: 'error'; reason: string }

export type DeleteResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'error'; reason: string }

export interface ListedEvent {
  eventId: string
  title: string
  start: Date
  end: Date
  isBooking: boolean
}

export interface HoldEventMeta {
  eventId: string
  bookingId: string
  expiresAt: Date
}

// ── Outbound mirror (Phase 2) ──────────────────────────────────────────────────

// A single write-through of a PA-managed entity into Google Calendar. Linkage is
// carried in extendedProperties.private (decision 9) — never the description —
// so the owner cannot accidentally break it by editing event text.
export interface MirrorEventInput {
  // When set, patch the existing Google event; otherwise insert a new one.
  googleEventId?: string | null
  summary: string
  description?: string
  start: Date
  end: Date
  colorId?: number | null
  // Stamped into extendedProperties.private. Always includes paManaged='1'.
  privateProps: Record<string, string>
}

export type MirrorResult =
  | { status: 'ok'; eventId: string; etag: string | null }
  | { status: 'error'; reason: string }

// ── Inbound sync (Phase 3) ──────────────────────────────────────────────────────

// Result of registering a Google push (watch) channel on the events resource.
export type WatchResult =
  | { status: 'ok'; resourceId: string | null; expiration: Date | null }
  | { status: 'error'; reason: string }

export type StopChannelResult =
  | { status: 'ok' }
  | { status: 'error'; reason: string }

// A raw Google event as seen by inbound sync. We deliberately keep the owner's
// title separate (callers must NOT surface it — privacy, decision: opaque blocks)
// and expose the PA linkage carried in extendedProperties.private.
export interface RawCalendarEvent {
  eventId: string
  status: string | null // 'confirmed' | 'tentative' | 'cancelled'
  summary: string | null
  // Owner event body. Read ONLY for a machine-readable class marker / classification;
  // never surfaced to a customer and never logged (privacy — decision #10).
  description: string | null
  start: Date | null
  end: Date | null
  etag: string | null
  paManaged: boolean // extendedProperties.private.paManaged === '1' ⇒ a PA-created event
  paType: string | null // 'booking' | 'block' | 'personal' | 'class'
  paId: string | null
}

export type IncrementalSyncResult =
  | { status: 'ok'; events: RawCalendarEvent[]; nextSyncToken: string | null }
  | { status: 'expired' } // 410 GONE — syncToken invalid; caller must full-reconcile
  | { status: 'error'; reason: string }

// Result of an authoritative single-event fetch (getEvent). Used by the booking-diff to
// CONFIRM a suspected deletion before cancelling: absence from a (possibly stale) list page is
// not proof. `cancelled` reflects Google's own tombstone flag (status==='cancelled').
//   ok+cancelled:false → the event still exists (a stale-list omission — keep the booking).
//   ok+cancelled:true / not_found → genuinely gone (cancel via the gated owner-wins path).
//   error → absence unconfirmed (fail safe: never cancel; the next reconcile retries).
export type GetEventResult =
  | { status: 'ok'; cancelled: boolean }
  | { status: 'not_found' } // 404/410 — the event is gone from Google
  | { status: 'error'; reason: string }

export interface IncrementalSyncOptions {
  syncToken?: string | null
  timeMin?: Date
  timeMax?: Date
}
