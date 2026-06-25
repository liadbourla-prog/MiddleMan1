import { describe, it, expect } from 'vitest'
import { buildScheduleView } from './orchestrator-tools.js'
import type { ListedEvent } from '../../adapters/calendar/types.js'
import type { CalendarBlock } from '../../db/schema.js'

// Regression for the live "old plan" bug (סטודיוגה, July 12): the manager edited
// Google directly — kept some classes, deleted others, added a personal meeting.
// The read merged the LIVE Google list with the (stale) calendar_blocks rows, so
// kept classes appeared TWICE and deleted classes were resurrected from the
// internal rows. In google mode, mirrored blocks (those with a googleEventId) must
// come ONLY from the live Google read; calendar_blocks contributes just the
// not-yet-mirrored rows.

const TZ = 'Asia/Jerusalem'
const LOCALE = 'he-IL'

function block(over: Partial<CalendarBlock> & { id: string; startTs: Date; endTs: Date }): CalendarBlock {
  return {
    businessId: 'biz',
    type: 'class',
    title: null,
    reason: null,
    serviceTypeId: null,
    maxParticipants: null,
    seriesId: null,
    providerId: null,
    googleEventId: null,
    googleEtag: null,
    source: 'internal',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as CalendarBlock
}

function ev(id: string, title: string, h: number): ListedEvent {
  return {
    eventId: id,
    title,
    start: new Date(`2026-07-12T${String(h).padStart(2, '0')}:00:00+03:00`),
    end: new Date(`2026-07-12T${String(h + 1).padStart(2, '0')}:00:00+03:00`),
    isBooking: false,
  }
}

function blk(id: string, title: string, h: number, googleEventId: string | null): CalendarBlock {
  return block({
    id,
    title,
    googleEventId,
    startTs: new Date(`2026-07-12T${String(h).padStart(2, '0')}:00:00+03:00`),
    endTs: new Date(`2026-07-12T${String(h + 1).padStart(2, '0')}:00:00+03:00`),
  })
}

describe('buildScheduleView — google mode dedup (July 12 regression)', () => {
  it('shows each mirrored class once and never resurrects an owner-deleted class', () => {
    // Live Google (owner kept 16:00 yoga + 18:00 pilates, deleted 9/10/11/14, added David at 12)
    const liveGoogle: ListedEvent[] = [
      ev('g-yoga16', 'יוגה', 16),
      ev('g-pil18', 'פילאטיס', 18),
      ev('g-david', 'פגישה עם דוד', 12),
    ]
    // Internal calendar_blocks still hold ALL 7 mirrored classes (stale until reconcile)
    const internalBlocks: CalendarBlock[] = [
      blk('b9', 'פילאטיס', 9, 'g-pil9'),
      blk('b10', 'יוגה', 10, 'g-yoga10'),
      blk('b11', 'פילאטיס', 11, 'g-pil11'),
      blk('b12', 'יוגה', 12, 'g-yoga12'),
      blk('b14', 'פילאטיס', 14, 'g-pil14'),
      blk('b16', 'יוגה', 16, 'g-yoga16'),
      blk('b18', 'פילאטיס', 18, 'g-pil18'),
    ]

    const view = buildScheduleView(liveGoogle, internalBlocks, {
      calendarMode: 'google',
      lang: 'he',
      locale: LOCALE,
      tz: TZ,
    })

    // Exactly the live Google picture: 12 David, 16 yoga, 18 pilates — no doubles,
    // no resurrected 9/10/11/14, no resurrected 12 yoga.
    expect(view).toHaveLength(3)
    expect(view.map((e) => e.title)).toEqual(['פגישה עם דוד', 'יוגה', 'פילאטיס'])
    // None of the deleted classes leak back in via the block rows.
    expect(view.some((e) => e.eventId.startsWith('block:'))).toBe(false)
  })

  it('still surfaces a not-yet-mirrored block (no googleEventId) in google mode', () => {
    const liveGoogle: ListedEvent[] = [ev('g-yoga16', 'יוגה', 16)]
    const blocks: CalendarBlock[] = [
      blk('b16', 'יוגה', 16, 'g-yoga16'), // already mirrored → comes from live read
      blk('bNew', 'אירוע חדש', 13, null), // just created, mirror pending → must show
    ]

    const view = buildScheduleView(liveGoogle, blocks, { calendarMode: 'google', lang: 'he', locale: LOCALE, tz: TZ })

    expect(view).toHaveLength(2)
    expect(view.find((e) => e.eventId === 'block:bNew')).toBeTruthy()
    // The mirrored 16:00 yoga appears once, from the live read (not the block row).
    expect(view.filter((e) => e.title === 'יוגה')).toHaveLength(1)
  })

  it('internal mode includes every block (no Google read to merge with)', () => {
    const blocks: CalendarBlock[] = [
      blk('b9', 'פילאטיס', 9, null),
      blk('b10', 'יוגה', 10, null),
    ]
    const view = buildScheduleView([], blocks, { calendarMode: 'internal', lang: 'he', locale: LOCALE, tz: TZ })
    expect(view).toHaveLength(2)
    expect(view.map((e) => e.eventId)).toEqual(['block:b9', 'block:b10'])
  })
})
