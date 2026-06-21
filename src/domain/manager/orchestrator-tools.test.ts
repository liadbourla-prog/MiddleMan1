import { describe, it, expect } from 'vitest'
import {
  executeCreateCalendarEvent,
  executeSelectCalendar,
  executeScheduleGroupSession,
  executeEditClassSession,
  executeScheduleRecurringClasses,
  type ToolContext,
} from './orchestrator-tools.js'
import type { CalendarListEntry } from '../calendar/calendar-id.js'

// A ctx whose db/calendar throw on ANY access. If an executor returns a
// clarification BEFORE touching either, we've proven the deterministic date
// guard fails closed with no write (Principle #1 — never persist a bad instant).
function noWriteCtx(): ToolContext {
  const trap = new Proxy(
    {},
    { get() { throw new Error('DB/calendar must NOT be touched when the date is unresolvable') } },
  )
  return {
    db: trap as unknown as ToolContext['db'],
    calendar: trap as unknown as ToolContext['calendar'],
    businessId: 'biz-1',
    identityId: 'id-1',
    timezone: 'Asia/Jerusalem',
    lang: 'en',
  }
}

describe('manager calendar writes — deterministic date guard (no write on bad date)', () => {
  it('createCalendarEvent: explicit past year → needsClarification, no DB write', async () => {
    const res = await executeCreateCalendarEvent(
      {
        title: 'Team sync',
        date: { explicitDate: { year: 2016, month: 1, day: 10 } },
        startTime: { hour: 10, minute: 0 },
        endTime: { hour: 11, minute: 0 },
      },
      noWriteCtx(),
    ) as { success: boolean; needsClarification?: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.needsClarification).toBe(true)
    expect(res.reason).toBe('past_year')
  })

  it('scheduleGroupSession: ambiguous week → needsClarification, no DB write', async () => {
    const res = await executeScheduleGroupSession(
      {
        serviceName: 'Vinyasa',
        date: { relativeDay: 'next_week' },
        startTime: { hour: 11, minute: 0 },
        endTime: { hour: 12, minute: 0 },
      },
      noWriteCtx(),
    ) as { success: boolean; needsClarification?: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.needsClarification).toBe(true)
    expect(res.reason).toBe('ambiguous_date')
  })

  it('scheduleGroupSession: DST-gap start time → needsClarification, no DB write', async () => {
    const res = await executeScheduleGroupSession(
      {
        date: { explicitDate: { year: 2027, month: 3, day: 26 } },
        startTime: { hour: 2, minute: 30 },
        endTime: { hour: 4, minute: 0 },
      },
      noWriteCtx(),
    ) as { success: boolean; needsClarification?: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.needsClarification).toBe(true)
    expect(res.reason).toBe('dst_gap')
  })

  it('createCalendarEvent: impossible calendar date (30 Feb) → needsClarification, no DB write', async () => {
    const res = await executeCreateCalendarEvent(
      {
        title: 'Inventory',
        date: { explicitDate: { year: 2026, month: 2, day: 30 } },
        startTime: { hour: 10, minute: 0 },
        endTime: { hour: 11, minute: 0 },
      },
      noWriteCtx(),
    ) as { success: boolean; needsClarification?: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.needsClarification).toBe(true)
    expect(res.reason).toBe('impossible_date')
  })

  it('createCalendarEvent: end at/before start → needsClarification, no DB write', async () => {
    const res = await executeCreateCalendarEvent(
      {
        title: 'Backwards block',
        date: { relativeDay: 'tomorrow' },
        startTime: { hour: 12, minute: 0 },
        endTime: { hour: 11, minute: 0 },
      },
      noWriteCtx(),
    ) as { success: boolean; needsClarification?: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.needsClarification).toBe(true)
    expect(res.reason).toBe('end_before_start')
  })

  it('scheduleGroupSession: no end time or duration → needsClarification, no DB write', async () => {
    const res = await executeScheduleGroupSession(
      {
        serviceName: 'Vinyasa',
        date: { relativeDay: 'tomorrow' },
        startTime: { hour: 11, minute: 0 },
        // neither endTime nor durationMinutes
      },
      noWriteCtx(),
    ) as { success: boolean; needsClarification?: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.needsClarification).toBe(true)
    expect(res.reason).toBe('no_time')
  })
})

// ── selectCalendar (F-b chat switch) ──────────────────────────────────────────
// A tiny db stub: the business row read, plus capture of the googleCalendarId write.
function selectCalendarCtx(opts: {
  calendarMode?: 'google' | 'internal'
  activeId?: string
  calendars: CalendarListEntry[]
  listThrows?: boolean
  onUpdate?: (id: string) => void
}): ToolContext {
  const bizRow = { calendarMode: opts.calendarMode ?? 'google', googleCalendarId: opts.activeId ?? 'primary' }
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [bizRow] }) }) }),
    update: () => ({ set: (vals: { googleCalendarId?: string }) => ({ where: async () => { if (vals.googleCalendarId) opts.onUpdate?.(vals.googleCalendarId) } }) }),
    insert: () => ({ values: async () => { /* logAudit */ } }),
  }
  const calendar = {
    listCalendars: async () => { if (opts.listThrows) throw new Error('boom'); return opts.calendars },
  }
  return {
    db: db as unknown as ToolContext['db'],
    calendar: calendar as unknown as ToolContext['calendar'],
    businessId: 'biz-1',
    identityId: 'id-1',
    timezone: 'Asia/Jerusalem',
    lang: 'en',
  }
}

const owner: CalendarListEntry = { id: 'owner@gmail.com', summary: 'Owner', accessRole: 'owner', primary: true }
const testing: CalendarListEntry = { id: 'testing@group.calendar.google.com', summary: 'Testing', accessRole: 'writer', primary: false }

describe('selectCalendar — chat-driven calendar selection (F-b)', () => {
  it('refuses when the business is not in google mode', async () => {
    const res = await executeSelectCalendar({ action: 'list' }, selectCalendarCtx({ calendarMode: 'internal', calendars: [] })) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('not_google_mode')
  })

  it('lists writable calendars and marks the active one', async () => {
    const res = await executeSelectCalendar(
      { action: 'list' },
      selectCalendarCtx({ activeId: 'owner@gmail.com', calendars: [owner, testing] }),
    ) as { success: boolean; calendars: { name: string; active: boolean }[]; activeCalendar: string }
    expect(res.success).toBe(true)
    expect(res.activeCalendar).toBe('Owner')
    expect(res.calendars).toEqual([
      { name: 'Owner', active: true },
      { name: 'Testing', active: false },
    ])
  })

  it('switches to a named secondary calendar and persists the validated id', async () => {
    let written: string | null = null
    const res = await executeSelectCalendar(
      { action: 'switch', calendarName: 'testing' },
      selectCalendarCtx({ activeId: 'owner@gmail.com', calendars: [owner, testing], onUpdate: (id) => { written = id } }),
    ) as { success: boolean; switchedTo?: string }
    expect(res.success).toBe(true)
    expect(res.switchedTo).toBe('Testing')
    expect(written).toBe('testing@group.calendar.google.com')
  })

  it('asks for clarification when the named calendar does not exist (no write)', async () => {
    let written: string | null = null
    const res = await executeSelectCalendar(
      { action: 'switch', calendarName: 'nonexistent' },
      selectCalendarCtx({ calendars: [owner, testing], onUpdate: (id) => { written = id } }),
    ) as { success: boolean; needsClarification?: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.needsClarification).toBe(true)
    expect(res.reason).toBe('calendar_not_found')
    expect(written).toBeNull()
  })

  it('reports already-active without rewriting when switching to the current calendar', async () => {
    let written: string | null = null
    const res = await executeSelectCalendar(
      { action: 'switch', calendarName: 'Owner' },
      selectCalendarCtx({ activeId: 'owner@gmail.com', calendars: [owner, testing], onUpdate: (id) => { written = id } }),
    ) as { success: boolean; alreadyActive?: boolean }
    expect(res.success).toBe(true)
    expect(res.alreadyActive).toBe(true)
    expect(written).toBeNull()
  })

  it('fails soft when the calendar list cannot be read', async () => {
    const res = await executeSelectCalendar(
      { action: 'list' },
      selectCalendarCtx({ calendars: [], listThrows: true }),
    ) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('calendar_read_failed')
  })
})

describe('scheduleRecurringClasses — fail-fast guards before any DB read (WS-D D2)', () => {
  it('empty classes list → needsClarification, no DB touch', async () => {
    const res = await executeScheduleRecurringClasses(
      { classes: [] },
      noWriteCtx(),
    ) as { success: boolean; needsClarification?: boolean }
    expect(res.success).toBe(false)
    expect(res.needsClarification).toBe(true)
  })

  it('two services every hour all week (> 200 tuples) → needsClarification, no DB touch', async () => {
    const everyHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, minute: 0 }))
    const allWeek = [0, 1, 2, 3, 4, 5, 6]
    const res = await executeScheduleRecurringClasses(
      { classes: [
        { serviceName: 'Yoga', daysOfWeek: allWeek, times: everyHour },     // 168
        { serviceName: 'Pilates', daysOfWeek: allWeek, times: everyHour },  // +168 = 336 > 200
      ] },
      noWriteCtx(),
    ) as { success: boolean; needsClarification?: boolean }
    expect(res.success).toBe(false)
    expect(res.needsClarification).toBe(true)
  })
})
