export interface CalendarSlot {
  start: Date
  end: Date
}

export type AvailabilityResult =
  | { status: 'available' }
  | { status: 'occupied' }
  | { status: 'error'; reason: string }

export type HoldResult =
  | { status: 'held'; eventId: string }
  | { status: 'conflict' }
  | { status: 'error'; reason: string }

export type ConfirmResult =
  | { status: 'confirmed'; eventId: string }
  | { status: 'error'; reason: string }

export type DeleteResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'error'; reason: string }

export interface HoldEventMeta {
  eventId: string
  bookingId: string
  expiresAt: Date
}
