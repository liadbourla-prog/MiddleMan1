import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { getTableName } from 'drizzle-orm'
import {
  executeCreateCalendarEvent,
  executeSelectCalendar,
  executeScheduleGroupSession,
  executeEditClassSession,
  executeScheduleRecurringClasses,
  executeGetSessionRoster,
  executeRequestPayment,
  executeRefundPayment,
  executeMessageCustomer,
  executeAnswerCustomerQuestion,
  executeSetCustomerName,
  executeManageAllowedContacts,
  executeConfigureDailyBriefing,
  type ToolContext,
} from './orchestrator-tools.js'
import type { CalendarListEntry } from '../calendar/calendar-id.js'
import type { Action } from '../authorization/check.js'
import type { BookingState } from '../../db/schema.js'

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

// Grow Phase 4 — requestPayment (Case B). Authorization is the FIRST gate and amount/desc
// validation is the SECOND; both run before any DB/calendar access. We use the no-write trap
// ctx to prove the matrix without touching state: customers/contacts/un-granted delegates are
// rejected; managers and granted delegates pass auth (and then hit the pre-DB amount guard).
function payCtx(role: ToolContext['role'], grants?: Action[]): ToolContext {
  return {
    ...noWriteCtx(),
    ...(role ? { role } : {}),
    ...(grants ? { delegatedPermissions: new Set<Action>(grants) } : {}),
  }
}

describe('requestPayment — authorization matrix (no state touched)', () => {
  const validArgs = { customer: 'Dana', amount: 300, description: 'Reformer session' }

  it('customer is refused', async () => {
    const res = await executeRequestPayment(validArgs, payCtx('customer')) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not_authorized')
  })

  it('contact is refused', async () => {
    const res = await executeRequestPayment(validArgs, payCtx('contact')) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not_authorized')
  })

  it('delegated user WITHOUT the payment.charge grant is refused', async () => {
    const res = await executeRequestPayment(validArgs, payCtx('delegated_user', ['schedule.set_availability'])) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not_authorized')
  })

  it('delegated user WITH the grant passes auth (then hits the pre-DB amount guard)', async () => {
    const res = await executeRequestPayment({ customer: 'Dana', amount: 0, description: 'x' }, payCtx('delegated_user', ['payment.charge'])) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('invalid_amount') // NOT not_authorized → auth passed
  })

  it('manager passes auth (then hits the pre-DB amount guard)', async () => {
    const res = await executeRequestPayment({ customer: 'Dana', amount: -5, description: 'x' }, payCtx('manager')) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('invalid_amount')
  })

  it('a manager with a valid amount but no description is stopped before any DB access', async () => {
    const res = await executeRequestPayment({ customer: 'Dana', amount: 300, description: '  ' }, payCtx('manager')) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('missing_description')
  })
})

describe('refundTransaction — authorization gate (no state touched on refusal)', () => {
  it('customer is refused before any DB access', async () => {
    const res = await executeRefundPayment({ customer: 'Dana' }, payCtx('customer')) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not_authorized')
  })

  it('delegated user WITHOUT the payment.refund grant is refused', async () => {
    const res = await executeRefundPayment({ customer: 'Dana' }, payCtx('delegated_user', ['payment.charge'])) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not_authorized') // charge grant does NOT imply refund
  })
})

describe('createCalendarEvent — owner-approval gate (no write until owner confirms)', () => {
  // A valid, resolvable future event: tomorrow 11:00–12:00. Date resolution succeeds, so the
  // ONLY thing standing between this call and a calendar write is the owner-approval gate.
  const validEvent = {
    title: 'Meeting with Yoni',
    date: { relativeDay: 'tomorrow' as const },
    startTime: { hour: 11, minute: 0 },
    endTime: { hour: 12, minute: 0 },
  }

  function approvalCtx(bookingAuthority: 'auto' | 'owner_approval'): ToolContext {
    return { ...noWriteCtx(), bookingAuthority }
  }

  it('owner_approval mode, first call (no ownerApproved) → awaiting_owner_approval, NO state touched', async () => {
    const res = await executeCreateCalendarEvent(validEvent, approvalCtx('owner_approval')) as {
      success: boolean; status?: string; proposed?: { title: string }
    }
    expect(res.success).toBe(false)
    expect(res.status).toBe('awaiting_owner_approval')
    expect(res.proposed?.title).toBe('Meeting with Yoni')
    // noWriteCtx throws on ANY db/calendar access → reaching this line proves no write happened.
  })

  it('owner_approval mode but ownerApproved:true → passes the gate (then hits db, proving no early return)', async () => {
    // With approval granted, the gate is cleared and execution proceeds to the conflict query,
    // which trips the no-write trap. The thrown error proves the gate did NOT short-circuit.
    await expect(
      executeCreateCalendarEvent({ ...validEvent, ownerApproved: true }, approvalCtx('owner_approval')),
    ).rejects.toThrow(/must NOT be touched|DB\/calendar/)
  })

  it('auto mode → no approval needed, proceeds straight to the write path (trips the trap)', async () => {
    await expect(
      executeCreateCalendarEvent(validEvent, approvalCtx('auto')),
    ).rejects.toThrow(/must NOT be touched|DB\/calendar/)
  })
})

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

function twoGuysCtx(): ToolContext {
  let call = 0
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'from', 'leftJoin', 'orderBy']) chain[m] = () => chain
  chain['where'] = () => chain
  chain['limit'] = () => {
    call += 1
    // 1st query: business row (messageCustomer loads it first). 2nd: identity name match (two rows).
    if (call === 1) return Promise.resolve([{ name: 'Studio', defaultLanguage: 'he', whatsappPhoneNumberId: 'wa', whatsappAccessToken: 'tok' }])
    if (call === 2) return Promise.resolve([
      { id: 'c1', displayName: 'Guy Cohen', lastName: 'Cohen', phoneNumber: '+972500000001' },
      { id: 'c2', displayName: 'Guy Levi', lastName: 'Levi', phoneNumber: '+972500000002' },
    ])
    return Promise.resolve([]) // latestBookingFor for each candidate
  }
  return {
    db: { select: () => chain } as unknown as ToolContext['db'],
    calendar: {} as ToolContext['calendar'],
    businessId: 'biz1', identityId: 'mgr1', timezone: 'Asia/Jerusalem', lang: 'he', role: 'manager',
  }
}

describe('answerCustomerQuestion — guards + wiring (F3a/S3)', () => {
  it('refuses an empty answer before touching the DB', async () => {
    const res = await executeAnswerCustomerQuestion({ answer: '   ' }, noWriteCtx()) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('empty_answer')
  })
  it('is declared as a tool and routed to the executor in the orchestrator', () => {
    const src = readFileSync(new URL('../../adapters/llm/orchestrator.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/name: 'answerCustomerQuestion'/)
    expect(src).toMatch(/case 'answerCustomerQuestion':[\s\S]*executeAnswerCustomerQuestion/)
    // Open questions are surfaced so the model knows to answer them.
    expect(src).toMatch(/Customer questions waiting for your answer/)
  })
})

describe('messageCustomer — disambiguation', () => {
  it('two same-name customers → ambiguous, no send, candidates returned', async () => {
    const res = await executeMessageCustomer({ name: 'Guy', message: 'Hi' }, twoGuysCtx()) as {
      ok: boolean; reason?: string; candidates?: unknown[]
    }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('ambiguous_customer')
    expect(res.candidates).toHaveLength(2)
  })
})

describe('requestPayment — disambiguation', () => {
  it('two same-name customers → refuses to charge, returns candidates', async () => {
    let call = 0
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'from', 'leftJoin', 'orderBy']) chain[m] = () => chain
    chain['where'] = () => chain
    chain['limit'] = () => {
      call += 1
      if (call === 1) return Promise.resolve([
        { id: 'c1', displayName: 'Dana Cohen', lastName: 'Cohen', phoneNumber: '+972500000001' },
        { id: 'c2', displayName: 'Dana Levi', lastName: 'Levi', phoneNumber: '+972500000002' },
      ])
      return Promise.resolve([]) // booking lookups
    }
    const ctx: ToolContext = {
      db: { select: () => chain } as unknown as ToolContext['db'],
      calendar: {} as ToolContext['calendar'],
      businessId: 'biz1', identityId: 'mgr1', timezone: 'Asia/Jerusalem', lang: 'he', role: 'manager',
    }
    const res = await executeRequestPayment({ customer: 'Dana', amount: 300, description: 'Session' }, ctx) as {
      ok: boolean; reason?: string; candidates?: unknown[]
    }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('ambiguous_customer')
    expect(res.candidates).toHaveLength(2)
  })
})

describe('setCustomerName', () => {
  it('rejects a non-manager/non-granted caller', async () => {
    const res = await executeSetCustomerName(
      { identityId: 'c1', displayName: 'Guy Cohen', lastName: 'Cohen' },
      payCtx('customer'),
    ) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not_authorized')
  })

  it('writes the name for the owner and derives lastName when only displayName is given', async () => {
    const captured: { patch?: Record<string, unknown> } = {}
    const chain: Record<string, unknown> = {}
    chain['set'] = (p: Record<string, unknown>) => { captured.patch = p; return chain }
    chain['where'] = () => Promise.resolve(undefined)
    const ctx: ToolContext = {
      db: { update: () => chain } as unknown as ToolContext['db'],
      calendar: {} as ToolContext['calendar'],
      businessId: 'biz1', identityId: 'mgr1', timezone: 'Asia/Jerusalem', lang: 'he', role: 'manager',
    }
    const res = await executeSetCustomerName({ identityId: 'c1', displayName: 'Guy Cohen' }, ctx) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(captured.patch).toEqual({ displayName: 'Guy Cohen', lastName: 'Cohen' })
  })
})

// ── manageAllowedContacts (Branch-3 allowlist control surface) ───────────────
// A stateful business-row stub: each select reflects the current row, each update
// merges the patch into the row. Lets us assert both the returned fact/flags AND
// the persisted contactRestrictionEnabled / allowedContacts columns.
function manageContactsCtx(initial?: { enabled?: boolean; list?: unknown }): {
  ctx: ToolContext
  row: { contactRestrictionEnabled: boolean; allowedContacts: unknown }
} {
  const row: { contactRestrictionEnabled: boolean; allowedContacts: unknown } = {
    contactRestrictionEnabled: initial?.enabled ?? false,
    allowedContacts: initial?.list ?? null,
  }
  const db = {
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            // Project only the requested column aliases (mirrors drizzle select shape).
            const projected: Record<string, unknown> = {}
            for (const key of Object.keys(cols)) {
              if (key === 'enabled') projected['enabled'] = row.contactRestrictionEnabled
              else if (key === 'list') projected['list'] = row.allowedContacts
            }
            return [projected]
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          if ('contactRestrictionEnabled' in patch) row.contactRestrictionEnabled = patch['contactRestrictionEnabled'] as boolean
          if ('allowedContacts' in patch) row.allowedContacts = patch['allowedContacts']
        },
      }),
    }),
    insert: () => ({ values: async () => { /* logAudit */ } }),
  }
  const ctx: ToolContext = {
    db: db as unknown as ToolContext['db'],
    calendar: {} as ToolContext['calendar'],
    businessId: 'biz-1',
    identityId: 'mgr-1',
    timezone: 'Asia/Jerusalem',
    lang: 'en',
    role: 'manager',
  }
  return { ctx, row }
}

describe('manageAllowedContacts', () => {
  it('enable → add → list reflects the added number in the fact', async () => {
    const { ctx } = manageContactsCtx()
    const en = await executeManageAllowedContacts({ op: 'enable' }, ctx) as { success: boolean }
    expect(en.success).toBe(true)

    const add = await executeManageAllowedContacts({ op: 'add', phone: '+972501234567', label: 'Dana' }, ctx) as { success: boolean }
    expect(add.success).toBe(true)

    const list = await executeManageAllowedContacts({ op: 'list' }, ctx) as { success: boolean; fact: string }
    expect(list.success).toBe(true)
    expect(list.fact).toContain('+972501234567')
  })

  it('add with an invalid phone returns invalid_phone (does not throw)', async () => {
    const { ctx } = manageContactsCtx({ enabled: true })
    const res = await executeManageAllowedContacts({ op: 'add', phone: '0501234567' }, ctx) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('invalid_phone')
  })

  it('add when restriction is off auto-enables (flag + persisted column)', async () => {
    const { ctx, row } = manageContactsCtx({ enabled: false })
    const res = await executeManageAllowedContacts({ op: 'add', phone: '+972501234567' }, ctx) as { success: boolean; autoEnabled?: boolean }
    expect(res.success).toBe(true)
    expect(res.autoEnabled).toBe(true)
    expect(row.contactRestrictionEnabled).toBe(true)
  })
})

// A stateful business-row stub that records the last update patch, so we can assert
// the persisted dailyBriefingEnabled / dailyBriefingTime columns. configureDailyBriefing
// only writes (no select), so we just need update + insert (logAudit) to be no-throw.
function dailyBriefingCtx(): {
  ctx: ToolContext
  row: { dailyBriefingEnabled?: boolean; dailyBriefingTime?: string }
} {
  const row: { dailyBriefingEnabled?: boolean; dailyBriefingTime?: string } = {}
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          if ('dailyBriefingEnabled' in patch) row.dailyBriefingEnabled = patch['dailyBriefingEnabled'] as boolean
          if ('dailyBriefingTime' in patch) row.dailyBriefingTime = patch['dailyBriefingTime'] as string
        },
      }),
    }),
    insert: () => ({ values: async () => { /* logAudit */ } }),
  }
  const ctx: ToolContext = {
    db: db as unknown as ToolContext['db'],
    calendar: {} as ToolContext['calendar'],
    businessId: 'biz-1',
    identityId: 'mgr-1',
    timezone: 'Asia/Jerusalem',
    lang: 'en',
    role: 'manager',
  }
  return { ctx, row }
}

// ── getSessionRoster (Branch-3 occupancy grounding) ──────────────────────────
// Fidelity note: this repo has no real-Postgres / pglite harness for domain code
// (see digest-queue.test.ts). So this is a STATEFUL FAKE-DB routed BY TABLE. The
// load-bearing part — that cancelled bookings are excluded from the count — is NOT
// faked: the bookings store holds ALL rows (a confirmed seat AND a cancelled one),
// and the stub interprets the REAL inArray(state, SEAT_STATES) filter that
// loadSessionRoster builds, so the genuine production exclusion logic runs.

interface SeatRow {
  customerId: string
  displayName: string | null
  state: BookingState
  paymentStatus: string
  providerId: string | null
  slotEnd: Date | null
}

// Walk the drizzle SQL filter tree for the bookings query and pull out the
// inArray(state, [...]) allow-list, so we apply the REAL state filter to our rows.
function extractStateAllowList(filter: any): string[] | null {
  if (filter == null || typeof filter !== 'object') return null
  const chunks: any[] = Array.isArray(filter.queryChunks) ? filter.queryChunks : []
  // Recurse into nested SQL (the and(...) wrapper holds the leaf operators).
  for (const c of chunks) {
    if (c && Array.isArray(c.queryChunks)) {
      const nested = extractStateAllowList(c)
      if (nested) return nested
    }
  }
  // Leaf: an "in" operator whose column is bookings.state and whose list is an
  // array chunk of param objects ({ value }).
  const col = chunks.find((c) => c && typeof c === 'object' && typeof c.name === 'string')
  const opText = chunks
    .filter((c) => c && typeof c === 'object' && Array.isArray(c.value))
    .map((c: any) => c.value.join(''))
    .join('')
  if (col?.name === 'state' && opText.includes(' in ')) {
    const listChunk = chunks.find((c) => Array.isArray(c))
    if (Array.isArray(listChunk)) return listChunk.map((p: any) => p.value as string)
  }
  return null
}

// A class session with `seats` bookings (some possibly cancelled). Routes each
// select() by the table named in .from(); the bookings read applies the real
// SEAT_STATES filter, every other read returns a fixed single-row result.
function rosterCtx(opts: {
  serviceId?: string
  serviceName?: string
  capacity?: number | null
  instructorName?: string | null
  seats: SeatRow[]
}): ToolContext {
  const serviceId = opts.serviceId ?? 'svc-yoga'
  const serviceName = opts.serviceName ?? 'Yoga'
  const capacity = opts.capacity ?? 4

  const db = {
    select: (_cols?: unknown) => {
      const builder: any = {
        _table: null as string | null,
        _filter: null as any,
        from: (table: unknown) => { builder._table = getTableName(table as any); return builder },
        innerJoin: () => builder,
        where: (f: any) => { builder._filter = f; return builder },
        // The bookings⋈identities read has NO .limit() — it is awaited directly.
        then: (resolve: (rows: unknown[]) => void) => {
          if (builder._table === 'bookings') {
            const allow = extractStateAllowList(builder._filter)
            const rows = (allow ? opts.seats.filter((s) => allow.includes(s.state)) : opts.seats)
              .map((s) => ({
                customerId: s.customerId,
                displayName: s.displayName,
                state: s.state,
                paymentStatus: s.paymentStatus,
                providerId: s.providerId,
                slotEnd: s.slotEnd,
              }))
            return resolve(rows)
          }
          return resolve([])
        },
        limit: async () => {
          switch (builder._table) {
            case 'calendar_blocks':
              return [{ providerId: 'inst-1', maxParticipants: capacity }]
            case 'service_types':
              return [{ id: serviceId, name: serviceName }]
            case 'identities':
              return [{ name: opts.instructorName ?? 'Dana' }]
            default:
              return []
          }
        },
      }
      return builder
    },
  }

  return {
    db: db as unknown as ToolContext['db'],
    calendar: {} as ToolContext['calendar'],
    businessId: 'biz-1',
    identityId: 'mgr-1',
    timezone: 'Asia/Jerusalem',
    lang: 'en',
    role: 'manager',
  }
}

describe('getSessionRoster — live, cancelled-excluded occupancy (no memory fabrication)', () => {
  const args = {
    serviceName: 'Yoga',
    date: { explicitDate: { year: 2099, month: 1, day: 15 } },
    time: { hour: 10, minute: 0 },
  }

  it('after one of two bookings is cancelled, count is 1 and only the remaining participant is returned', async () => {
    const ctx = rosterCtx({
      seats: [
        { customerId: 'c1', displayName: 'Harel', state: 'confirmed', paymentStatus: 'paid', providerId: 'inst-1', slotEnd: null },
        // The customer who rescheduled OUT of this slot — cancelled. Must NOT count.
        { customerId: 'c2', displayName: 'Noa', state: 'cancelled', paymentStatus: 'paid', providerId: 'inst-1', slotEnd: null },
      ],
    })

    const res = await executeGetSessionRoster(args, ctx) as {
      found: boolean; count: number; capacity: number | null; spotsLeft: number | null
      participants: { name: string | null }[]; guidance?: string
    }

    expect(res.found).toBe(true)
    expect(res.count).toBe(1)
    const names = res.participants.map((p) => p.name)
    expect(names).toContain('Harel')
    expect(names).not.toContain('Noa') // the cancelled/rescheduled-out customer is gone
    expect(res.capacity).toBe(4)
    expect(res.spotsLeft).toBe(3)
    expect(res.guidance).toMatch(/cancelled bookings excluded/i)
  })

  it('fails closed with a clarify on an unresolvable date — no DB access', async () => {
    const res = await executeGetSessionRoster(
      { serviceName: 'Yoga', date: { explicitDate: { year: 2016, month: 1, day: 1 } }, time: { hour: 10, minute: 0 } },
      noWriteCtx(),
    ) as { success?: boolean; needsClarification?: boolean; reason?: string }
    expect(res.needsClarification).toBe(true)
    expect(res.reason).toBe('past_year')
  })
})

describe('configureDailyBriefing', () => {
  it('enabled=true persists dailyBriefingEnabled=true', async () => {
    const { ctx, row } = dailyBriefingCtx()
    const res = await executeConfigureDailyBriefing({ enabled: true }, ctx) as { success: boolean }
    expect(res.success).toBe(true)
    expect(row.dailyBriefingEnabled).toBe(true)
  })

  it("time='08:00' persists dailyBriefingTime='08:00'", async () => {
    const { ctx, row } = dailyBriefingCtx()
    const res = await executeConfigureDailyBriefing({ time: '08:00' }, ctx) as { success: boolean }
    expect(res.success).toBe(true)
    expect(row.dailyBriefingTime).toBe('08:00')
  })

  it("invalid time '8am' returns invalid_time (no write)", async () => {
    const { ctx, row } = dailyBriefingCtx()
    const res = await executeConfigureDailyBriefing({ time: '8am' }, ctx) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('invalid_time')
    expect(row.dailyBriefingTime).toBeUndefined()
  })

  it('no args returns nothing_to_change', async () => {
    const { ctx } = dailyBriefingCtx()
    const res = await executeConfigureDailyBriefing({}, ctx) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('nothing_to_change')
  })
})
