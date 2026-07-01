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
  executeSetCustomerGender,
  executeManageAllowedContacts,
  executeConfigureDailyBriefing,
  executeConfigureProactiveFeatures,
  proactiveFeatureColumn,
  PROACTIVE_FEATURE_COLUMNS,
  executeConfigureEscalationRules,
  addEscalationRule,
  removeEscalationRule,
  type ToolContext,
} from './orchestrator-tools.js'
import type { CalendarListEntry } from '../calendar/calendar-id.js'
import type { Action } from '../authorization/check.js'
import type { BookingState, EscalationRule } from '../../db/schema.js'

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
  it('opens a pending imported class when the owner AFFIRMS a block-linked question (T1.3, test f)', () => {
    // Wiring lock-in (this file's convention): a block-linked question + affirmative answer
    // materializes the class via confirmImportedClass, gated on parseConfirmation to preserve
    // decision #10 (a non-yes answer never auto-opens a private class).
    const src = readFileSync(new URL('./orchestrator-tools.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/relatedBlockId && parseConfirmation\(answer\) === 'yes'/)
    expect(src).toMatch(/confirmImportedClass\(ctx\.db, ctx\.businessId, q\.relatedBlockId\)/)
  })
})

describe('saveContactNote — tenant isolation (D1 IDOR guard)', () => {
  // The customer branch resolves customer_profiles by an LLM-supplied identityId. Both the
  // SELECT and the UPDATE MUST be scoped by ctx.businessId, or a foreign identityId (e.g. one
  // that leaked into the model's context on the shared central number) could read or poison
  // another tenant's profile notes. A behavioral test can't assert this against the opaque
  // Drizzle conditions used in the unit mocks, so we guard the source directly (same idiom as
  // the orchestrator wiring test above).
  it('scopes both the read and the write of customer_profiles by businessId', () => {
    const src = readFileSync(new URL('./orchestrator-tools.ts', import.meta.url), 'utf8')
    const customerBranch = src.slice(
      src.indexOf("args.targetType === 'customer'"),
      src.indexOf("args.targetType === 'business_contact'"),
    )
    expect(customerBranch.length).toBeGreaterThan(0)
    // SELECT must filter by both identityId and businessId.
    expect(customerBranch).toMatch(
      /eq\(customerProfiles\.identityId, args\.identifier\), eq\(customerProfiles\.businessId, ctx\.businessId\)/,
    )
    // Both the read and the update carry the businessId scope (>= 2 occurrences).
    const scoped = customerBranch.match(/eq\(customerProfiles\.businessId, ctx\.businessId\)/g) ?? []
    expect(scoped.length).toBeGreaterThanOrEqual(2)
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

describe('setCustomerGender (T1.2 — owner correction, source=explicit + ledger)', () => {
  function genderCtx(role: ToolContext['role'], grants?: Action[]): {
    ctx: ToolContext
    patches: Array<Record<string, unknown>>
    audits: Array<Record<string, unknown>>
  } {
    const patches: Array<Record<string, unknown>> = []
    const audits: Array<Record<string, unknown>> = []
    const updateChain: Record<string, unknown> = {}
    updateChain['set'] = (p: Record<string, unknown>) => { patches.push(p); return updateChain }
    updateChain['where'] = () => Promise.resolve(undefined)
    const db = {
      update: () => updateChain,
      insert: () => ({ values: async (v: Record<string, unknown>) => { audits.push(v) } }),
    }
    return {
      ctx: {
        db: db as unknown as ToolContext['db'],
        calendar: {} as ToolContext['calendar'],
        businessId: 'biz1', identityId: 'mgr1', timezone: 'Asia/Jerusalem', lang: 'he',
        ...(role ? { role } : {}),
        ...(grants ? { delegatedPermissions: new Set<Action>(grants) } : {}),
      },
      patches,
      audits,
    }
  }

  it('rejects a non-manager/non-granted caller (no write, no ledger)', async () => {
    const { ctx, patches, audits } = genderCtx('customer')
    const res = await executeSetCustomerGender({ identityId: 'c1', gender: 'female' }, ctx) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not_authorized')
    expect(patches).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  it('writes addresseeGender=female source=explicit for the owner and logs an audit row', async () => {
    const { ctx, patches, audits } = genderCtx('manager')
    const res = await executeSetCustomerGender({ identityId: 'c1', gender: 'female' }, ctx) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(patches.at(-1)).toMatchObject({ addresseeGender: 'female', addresseeGenderSource: 'explicit' })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ businessId: 'biz1', action: 'customer.gender_set', entityId: 'c1' })
  })

  it('requires a target id', async () => {
    const { ctx, patches } = genderCtx('manager')
    const res = await executeSetCustomerGender({ gender: 'male' }, ctx) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no_target')
    expect(patches).toHaveLength(0)
  })

  it('rejects an invalid gender value', async () => {
    const { ctx, patches } = genderCtx('manager')
    const res = await executeSetCustomerGender({ identityId: 'c1', gender: 'other' as 'male' }, ctx) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('invalid_gender')
    expect(patches).toHaveLength(0)
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

// ── configureProactiveFeatures ──────────────────────────────────────────────
// A capture-db ctx: proves the executor writes the RIGHT column (the map is the whole
// behaviour) without a real DB. Mirrors dailyBriefingCtx.
function proactiveCtx(): { ctx: ToolContext; patch: Record<string, unknown> } {
  const patch: Record<string, unknown> = {}
  const db = {
    update: () => ({ set: (p: Record<string, unknown>) => ({ where: async () => { Object.assign(patch, p) } }) }),
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
  return { ctx, patch }
}

describe('proactiveFeatureColumn — feature→column map', () => {
  it('maps every known feature to its businesses column', () => {
    expect(proactiveFeatureColumn('winback')).toBe('proactiveWinbackEnabled')
    expect(proactiveFeatureColumn('subscription_renewal')).toBe('subscriptionRenewalEnabled')
    expect(proactiveFeatureColumn('post_appointment_thankyou')).toBe('postAppointmentThankyouEnabled')
    expect(proactiveFeatureColumn('periodic_treatment')).toBe('periodicTreatmentEnabled')
    expect(proactiveFeatureColumn('birthday_greetings')).toBe('birthdayGreetingsEnabled')
    expect(proactiveFeatureColumn('reschedule_retention')).toBe('rescheduleRetentionEnabled')
  })

  it('returns null for an unknown feature (allow-list, no accidental column writes)', () => {
    expect(proactiveFeatureColumn('marketing_blast')).toBeNull()
    expect(proactiveFeatureColumn('')).toBeNull()
    expect(Object.keys(PROACTIVE_FEATURE_COLUMNS)).toHaveLength(6)
  })
})

describe('configureProactiveFeatures — write', () => {
  it('enabling birthday_greetings sets birthdayGreetingsEnabled = true', async () => {
    const { ctx, patch } = proactiveCtx()
    const res = await executeConfigureProactiveFeatures({ feature: 'birthday_greetings', enabled: true }, ctx) as { success: boolean }
    expect(res.success).toBe(true)
    expect(patch).toEqual({ birthdayGreetingsEnabled: true })
  })

  it('disabling winback sets proactiveWinbackEnabled = false', async () => {
    const { ctx, patch } = proactiveCtx()
    const res = await executeConfigureProactiveFeatures({ feature: 'winback', enabled: false }, ctx) as { success: boolean }
    expect(res.success).toBe(true)
    expect(patch).toEqual({ proactiveWinbackEnabled: false })
  })

  it('enabling winback tells the owner it will ask-first (guidance mentions checking each one)', async () => {
    const { ctx } = proactiveCtx()
    const res = await executeConfigureProactiveFeatures({ feature: 'winback', enabled: true }, ctx) as { success: boolean; guidance: string }
    expect(res.success).toBe(true)
    expect(res.guidance).toMatch(/check each one|before sending/i)
  })

  it('unknown feature writes nothing and asks which feature (as manager)', async () => {
    const { ctx, patch } = proactiveCtx()
    const res = await executeConfigureProactiveFeatures({ feature: 'marketing_blast', enabled: true }, ctx) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('unknown_feature')
    expect(patch).toEqual({})
  })
})

describe('configureProactiveFeatures — authorization (no state touched)', () => {
  const args = { feature: 'birthday_greetings', enabled: true }

  it('customer is refused', async () => {
    const res = await executeConfigureProactiveFeatures(args, payCtx('customer')) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('not_authorized')
  })

  it('contact is refused', async () => {
    const res = await executeConfigureProactiveFeatures(args, payCtx('contact')) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('not_authorized')
  })

  it('delegated user WITHOUT settings.configure is refused', async () => {
    const res = await executeConfigureProactiveFeatures(args, payCtx('delegated_user')) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('not_authorized')
  })

  it('delegated user WITH settings.configure passes auth (unknown feature reached, no write)', async () => {
    // A granted delegate + unknown feature proves the grant opens the gate without touching the
    // trap DB: we get unknown_feature, not not_authorized.
    const res = await executeConfigureProactiveFeatures(
      { feature: 'nope', enabled: true },
      payCtx('delegated_user', ['settings.configure']),
    ) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('unknown_feature')
  })
})

// ── configureEscalationRules ────────────────────────────────────────────────
describe('escalation-rule pure helpers', () => {
  const kw = (value: string): EscalationRule => ({ trigger: 'keyword', value, customerMessage: 'passed_to_owner' })

  it('add appends and is idempotent on the same keyword (case-insensitive)', () => {
    const a = addEscalationRule(null, kw('refund'))
    expect(a).toHaveLength(1)
    const b = addEscalationRule(a, kw('REFUND'))
    expect(b).toHaveLength(1) // same keyword, not duplicated
    const c = addEscalationRule(b, kw('lawyer'))
    expect(c).toHaveLength(2)
  })

  it('only one emotional / one unknown_intent rule is kept', () => {
    const list = addEscalationRule(null, { trigger: 'emotional', customerMessage: 'silent' })
    const again = addEscalationRule(list, { trigger: 'emotional', customerMessage: 'owner_callback' })
    expect(again).toHaveLength(1)
  })

  it('remove drops a matching keyword and is a no-op otherwise', () => {
    const list = addEscalationRule(null, kw('refund'))
    expect(removeEscalationRule(list, 'keyword', 'refund')).toEqual([])
    expect(removeEscalationRule(list, 'keyword', 'other')).toEqual(list)
    expect(removeEscalationRule(list, 'emotional')).toEqual(list)
  })
})

// A capture-db ctx that also answers the initial SELECT of current rules.
function escCtx(rules: EscalationRule[] = [], role: ToolContext['role'] = 'manager', grants?: Action[]): { ctx: ToolContext; patch: Record<string, unknown> } {
  const patch: Record<string, unknown> = {}
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ rules }] }) }) }),
    update: () => ({ set: (p: Record<string, unknown>) => ({ where: async () => { Object.assign(patch, p) } }) }),
    insert: () => ({ values: async () => { /* logAudit */ } }),
  }
  const ctx: ToolContext = {
    db: db as unknown as ToolContext['db'],
    calendar: {} as ToolContext['calendar'],
    businessId: 'biz-1',
    identityId: 'mgr-1',
    timezone: 'Asia/Jerusalem',
    lang: 'en',
    ...(role ? { role } : {}),
    ...(grants ? { delegatedPermissions: new Set<Action>(grants) } : {}),
  }
  return { ctx, patch }
}

describe('configureEscalationRules — write', () => {
  it('adds a keyword rule and persists it', async () => {
    const { ctx, patch } = escCtx([])
    const res = await executeConfigureEscalationRules({ op: 'add', trigger: 'keyword', value: 'refund' }, ctx) as { success: boolean }
    expect(res.success).toBe(true)
    expect(patch['escalationRules']).toEqual([{ trigger: 'keyword', value: 'refund', customerMessage: 'passed_to_owner' }])
  })

  it('removes an existing rule', async () => {
    const existing: EscalationRule[] = [{ trigger: 'keyword', value: 'refund', customerMessage: 'passed_to_owner' }]
    const { ctx, patch } = escCtx(existing)
    const res = await executeConfigureEscalationRules({ op: 'remove', trigger: 'keyword', value: 'refund' }, ctx) as { success: boolean }
    expect(res.success).toBe(true)
    expect(patch['escalationRules']).toEqual([])
  })

  it('list returns current rules without writing', async () => {
    const existing: EscalationRule[] = [{ trigger: 'emotional', customerMessage: 'owner_callback' }]
    const { ctx, patch } = escCtx(existing)
    const res = await executeConfigureEscalationRules({ op: 'list' }, ctx) as { success: boolean; fact: string }
    expect(res.success).toBe(true)
    expect(JSON.parse(res.fact)).toEqual(existing)
    expect(patch).toEqual({}) // no write on a read
  })

  it('keyword trigger without a value asks for the word (no write)', async () => {
    const { ctx, patch } = escCtx([])
    const res = await executeConfigureEscalationRules({ op: 'add', trigger: 'keyword' }, ctx) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('missing_keyword')
    expect(patch).toEqual({})
  })

  it('removing a rule that is not there reports rule_not_found', async () => {
    const { ctx } = escCtx([])
    const res = await executeConfigureEscalationRules({ op: 'remove', trigger: 'keyword', value: 'ghost' }, ctx) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('rule_not_found')
  })
})

describe('configureEscalationRules — authorization', () => {
  const args = { op: 'add' as const, trigger: 'emotional' }

  it('customer / contact / un-granted delegate are refused before any DB touch', async () => {
    for (const role of ['customer', 'contact', 'delegated_user'] as const) {
      const res = await executeConfigureEscalationRules(args, payCtx(role)) as { success: boolean; reason?: string }
      expect(res.success, role).toBe(false)
      expect(res.reason, role).toBe('not_authorized')
    }
  })

  it('delegated user WITH settings.configure passes auth and writes', async () => {
    const { ctx, patch } = escCtx([], 'delegated_user', ['settings.configure'])
    const res = await executeConfigureEscalationRules(args, ctx) as { success: boolean }
    expect(res.success).toBe(true)
    expect(patch['escalationRules']).toEqual([{ trigger: 'emotional', customerMessage: 'passed_to_owner' }])
  })
})
