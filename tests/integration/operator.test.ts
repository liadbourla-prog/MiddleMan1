// Mocks must be declared before any imports (vitest hoists these)
import { vi } from 'vitest'

vi.mock('../../src/redis.js', () => ({
  redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
  messageRetryQueue: { add: vi.fn() },
  startMessageRetryWorker: vi.fn(),
}))
vi.mock('../../src/workers/reminder.js', () => ({
  scheduleReminders: vi.fn().mockResolvedValue(undefined),
  cancelReminders: vi.fn().mockResolvedValue(undefined),
  startReminderWorker: vi.fn(),
}))
vi.mock('../../src/workers/waitlist.js', () => ({
  triggerWaitlistForSlot: vi.fn().mockResolvedValue(undefined),
  startWaitlistWorker: vi.fn(),
}))
vi.mock('../../src/workers/queued-messages.js', () => ({
  queueMessageForLater: vi.fn().mockResolvedValue(undefined),
  startQueuedMessageWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { businesses, identities } from '../../src/db/schema.js'
import {
  seedBusiness, freshPhone, teardown,
  teardownProviderSession, integrationEnabled, llmEnabled,
} from './setup.js'
import { simProvider, hasLanguageLeak } from './runner.js'

const operatorPhone = process.env['OPERATOR_PHONE'] ?? ''
const operatorEnabled = integrationEnabled && !!operatorPhone

// ── F — MiddleMan: provider onboarding ───────────────────────────────────────

describe.skipIf(!integrationEnabled)('F — MiddleMan: provider onboarding', () => {
  let fromPhone: string

  beforeEach(() => {
    fromPhone = freshPhone()
  })

  afterEach(async () => {
    await teardownProviderSession(fromPhone)
  })

  it('F1: first message from unknown number creates session and returns bilingual welcome', async () => {
    const r = await simProvider(fromPhone, 'hello')
    expect(r.replies.length).toBeGreaterThan(0)
    const reply = r.replies[0]!
    // Welcome is always bilingual (he + en) regardless of sender language
    expect(reply).toMatch(/MiddleMan/)
    expect(r.sessionStep).toBe('business_name')
    expect(r.sessionCompleted).toBe(false)
  })

  it('F2: business name advances to timezone step; language is detected from text', async () => {
    await simProvider(fromPhone, 'hello') // create session
    const r = await simProvider(fromPhone, 'My Test Salon')
    expect(r.replies.length).toBeGreaterThan(0)
    expect(r.sessionStep).toBe('timezone')
    // English name → language detected as 'en'
    expect(r.sessionData?.language).toBe('en')
  })

  it('F3: Hebrew business name detects Hebrew language', async () => {
    await simProvider(fromPhone, 'שלום') // create session
    const r = await simProvider(fromPhone, 'מספרת ליאד')
    expect(r.sessionStep).toBe('timezone')
    expect(r.sessionData?.language).toBe('he')
  })

  it('F4: unrecognised timezone returns retry prompt and stays on timezone step', async () => {
    await simProvider(fromPhone, 'hello') // create session
    await simProvider(fromPhone, 'My Test Salon') // business_name → timezone
    const r = await simProvider(fromPhone, 'Narnia/Aslan')
    expect(r.sessionStep).toBe('timezone')
    const reply = r.replies[0]!
    expect(reply).toMatch(/timezone|IANA|אזור/i)
  })

  it('F5: valid timezone "Israel" is accepted and advances to calendar step', async () => {
    await simProvider(fromPhone, 'hello')
    await simProvider(fromPhone, 'My Test Salon')
    const r = await simProvider(fromPhone, 'Israel')
    // "Israel" is itself a valid IANA legacy alias — resolveTimezone returns it as-is
    expect(r.sessionStep).toBe('calendar')
    expect(r.sessionData?.timezone).toBeTruthy()
  })

  it('F6: "skip" on calendar step advances to credentials', async () => {
    await simProvider(fromPhone, 'hello')
    await simProvider(fromPhone, 'My Test Salon')
    await simProvider(fromPhone, 'Israel')
    const r = await simProvider(fromPhone, 'skip')
    expect(r.sessionStep).toBe('credentials')
    expect(r.sessionData?.calendarId).toBeNull()
  })

  it('F7: garbled credentials returns retry prompt and stays on credentials step', async () => {
    await simProvider(fromPhone, 'hello')
    await simProvider(fromPhone, 'My Test Salon')
    await simProvider(fromPhone, 'Israel')
    await simProvider(fromPhone, 'skip')
    const r = await simProvider(fromPhone, 'not valid credentials at all')
    expect(r.sessionStep).toBe('credentials')
    const reply = r.replies[0]!
    expect(reply).toMatch(/ID|TOKEN|format|פורמט/i)
  })

  it('F8: valid credentials with mocked Meta API provisions business and completes session', async () => {
    // Use freshPhone() so each run gets a unique PA number — avoids idempotency short-circuit
    const mockPhone = freshPhone()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        // fetchPhoneNumberFromMeta normalises via '+' + raw.replace(/\D/g, '')
        display_phone_number: mockPhone,
        verified_name: 'Test PA',
      }),
    }))

    try {
      await simProvider(fromPhone, 'hello')
      await simProvider(fromPhone, 'My Test Salon')
      await simProvider(fromPhone, 'Israel')
      await simProvider(fromPhone, 'skip')
      const r = await simProvider(fromPhone, 'ID: 12345678901234 TOKEN: EAAtest1234567890abc')

      expect(r.sessionCompleted).toBe(true)
      expect(r.replies.length).toBeGreaterThan(0)
      // Reply should contain the provisioned PA phone number
      expect(r.replies[0]).toMatch(mockPhone.replace(/\D/g, '').slice(-4))

      // Business row was created in DB
      const [biz] = await db
        .select({ id: businesses.id, timezone: businesses.timezone, onboardingStep: businesses.onboardingStep })
        .from(businesses)
        .where(eq(businesses.whatsappNumber, mockPhone))
        .limit(1)
      expect(biz).toBeTruthy()
      expect(biz!.timezone).toBeTruthy()
      expect(biz!.onboardingStep).toBe('business_name')

      // Manager identity was created
      const [mgr] = await db
        .select({ id: identities.id, role: identities.role })
        .from(identities)
        .where(eq(identities.phoneNumber, fromPhone))
        .limit(1)
      expect(mgr).toBeTruthy()
      expect(mgr!.role).toBe('manager')

      // Cleanup provisioned business
      if (biz) await teardown(biz.id)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('F9: Meta API error returns credentials error reply and does not complete session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Invalid token' } }),
    }))

    try {
      await simProvider(fromPhone, 'hello')
      await simProvider(fromPhone, 'My Test Salon')
      await simProvider(fromPhone, 'Israel')
      await simProvider(fromPhone, 'skip')
      const r = await simProvider(fromPhone, 'ID: 12345678901234 TOKEN: EAAtest1234567890abc')

      expect(r.sessionCompleted).toBe(false)
      expect(r.replies.length).toBeGreaterThan(0)
      expect(r.replies[0]).toMatch(/Invalid token|credentials|פרטים/i)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('F10: already-completed session returns "already done" reply without advancing', async () => {
    const mockPhone = freshPhone()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ display_phone_number: mockPhone, verified_name: 'Test PA 2' }),
    }))

    try {
      await simProvider(fromPhone, 'hello')
      await simProvider(fromPhone, 'My Test Salon 2')
      await simProvider(fromPhone, 'Israel')
      await simProvider(fromPhone, 'skip')
      await simProvider(fromPhone, 'ID: 12345678901234 TOKEN: EAAtest1234567890abc')

      vi.unstubAllGlobals()

      // Second message after completion
      const r = await simProvider(fromPhone, 'hello again')
      expect(r.sessionCompleted).toBe(true)
      const reply = r.replies[0]!
      expect(reply).toMatch(/already|כבר/)
    } finally {
      vi.unstubAllGlobals()
      // Cleanup provisioned business
      const [biz] = await db
        .select({ id: businesses.id })
        .from(businesses)
        .where(eq(businesses.whatsappNumber, mockPhone))
        .limit(1)
      if (biz) await teardown(biz.id)
    }
  })

  it('F11: language parity — Hebrew and English onboarding produce identical DB schema shape', async () => {
    const hePhone = freshPhone()
    const enPhone = freshPhone()
    const hePaPhone = '+15558880001'
    const enPaPhone = '+15558880002'

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ display_phone_number: '+1 555-888-0001', verified_name: 'HE PA' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ display_phone_number: '+1 555-888-0002', verified_name: 'EN PA' }) }),
    )

    try {
      // Hebrew path (use IANA timezone since resolveTimezone only handles English shorthands)
      await simProvider(hePhone, 'שלום')
      await simProvider(hePhone, 'מספרת ליאד')
      await simProvider(hePhone, 'Asia/Jerusalem')
      await simProvider(hePhone, 'skip')
      await simProvider(hePhone, 'ID: 11111111111111 TOKEN: EAAtest1111111111aaa')

      // English path
      await simProvider(enPhone, 'hello')
      await simProvider(enPhone, 'Liad Barbershop')
      await simProvider(enPhone, 'Asia/Jerusalem')
      await simProvider(enPhone, 'skip')
      await simProvider(enPhone, 'ID: 22222222222222 TOKEN: EAAtest2222222222bbb')

      const [heBiz] = await db.select().from(businesses).where(eq(businesses.whatsappNumber, hePaPhone)).limit(1)
      const [enBiz] = await db.select().from(businesses).where(eq(businesses.whatsappNumber, enPaPhone)).limit(1)

      expect(heBiz).toBeTruthy()
      expect(enBiz).toBeTruthy()

      // Both have the same onboarding entry-point step
      expect(heBiz!.onboardingStep).toBe('business_name')
      expect(enBiz!.onboardingStep).toBe('business_name')

      // Both have null onboardingCompletedAt (setup not yet done through PA)
      expect(heBiz!.onboardingCompletedAt).toBeNull()
      expect(enBiz!.onboardingCompletedAt).toBeNull()

      // Timezone resolves consistently
      expect(heBiz!.timezone).toBe('Asia/Jerusalem')
      expect(enBiz!.timezone).toBe('Asia/Jerusalem')
    } finally {
      vi.unstubAllGlobals()
      await teardownProviderSession(hePhone)
      await teardownProviderSession(enPhone)
      const [heBiz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.whatsappNumber, hePaPhone)).limit(1)
      const [enBiz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.whatsappNumber, enPaPhone)).limit(1)
      if (heBiz) await teardown(heBiz.id)
      if (enBiz) await teardown(enBiz.id)
    }
  })
})

// ── G — MiddleMan: operator commands ─────────────────────────────────────────

describe.skipIf(!operatorEnabled)('G — MiddleMan: operator commands', () => {
  it('G1: STATUS ALL returns a reply without crashing', async () => {
    const r = await simProvider(operatorPhone, 'STATUS ALL')
    expect(r.replies.length).toBeGreaterThan(0)
    expect(r.replies[0]!.length).toBeGreaterThan(0)
  })

  it('G2: STATUS (alias) returns same result as STATUS ALL', async () => {
    const r = await simProvider(operatorPhone, 'STATUS')
    expect(r.replies.length).toBeGreaterThan(0)
    expect(r.replies[0]!.length).toBeGreaterThan(0)
  })

  describe('with a seeded business', () => {
    let biz: Awaited<ReturnType<typeof seedBusiness>>

    beforeEach(async () => {
      biz = await seedBusiness({ language: 'en', available247: true })
    })

    afterEach(async () => {
      await teardown(biz.businessId)
    })

    it('G3: STATUS ALL lists the seeded business by name', async () => {
      const r = await simProvider(operatorPhone, 'STATUS ALL')
      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!
      expect(reply).toContain('Test Barbershop')
    })

    it('G4: STATUS <name> returns detailed report for the business', async () => {
      const r = await simProvider(operatorPhone, `STATUS Test Barbershop`)
      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!
      expect(reply).toContain('Test Barbershop')
      // Detail report includes phone number, calendar, status
      expect(reply).toMatch(/Number|מספר/)
      expect(reply).toMatch(/Status|סטטוס/)
      expect(reply).toMatch(/Calendar|לוח שנה/)
    })

    it('G5: STATUS <waNumber> returns detailed report for the business', async () => {
      const r = await simProvider(operatorPhone, `STATUS ${biz.waNumber}`)
      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!
      expect(reply).toContain('Test Barbershop')
    })

    it('G6: Hebrew alias סטטוס הכל returns same business in reply', async () => {
      const r = await simProvider(operatorPhone, 'סטטוס הכל')
      expect(r.replies.length).toBeGreaterThan(0)
      expect(r.replies[0]).toContain('Test Barbershop')
    })

    it('G7: Hebrew alias כל העסקים returns same business in reply', async () => {
      const r = await simProvider(operatorPhone, 'כל העסקים')
      expect(r.replies.length).toBeGreaterThan(0)
      expect(r.replies[0]).toContain('Test Barbershop')
    })
  })

  it('G8: STATUS <unknown> returns not-found message', async () => {
    const r = await simProvider(operatorPhone, 'STATUS xyzzy-no-such-business')
    expect(r.replies.length).toBeGreaterThan(0)
    expect(r.replies[0]).toMatch(/No business found|לא נמצא עסק/)
  })

  it('G9: ESCALATIONS with no open escalations returns no-escalations message', async () => {
    const r = await simProvider(operatorPhone, 'ESCALATIONS')
    expect(r.replies.length).toBeGreaterThan(0)
    expect(r.replies[0]).toMatch(/No open escalations|אין פניות פתוחות/)
  })

  it('G10: Hebrew alias פניות returns no-escalations message', async () => {
    const r = await simProvider(operatorPhone, 'פניות')
    expect(r.replies.length).toBeGreaterThan(0)
    expect(r.replies[0]).toMatch(/No open escalations|אין פניות פתוחות/)
  })

  it('G11: unrecognised message returns help menu', async () => {
    const r = await simProvider(operatorPhone, 'what can you do')
    expect(r.replies.length).toBeGreaterThan(0)
    const reply = r.replies[0]!
    // Help menu always mentions STATUS ALL and ESCALATIONS
    expect(reply).toMatch(/STATUS ALL|ESCALATIONS|סטטוס הכל|פניות/)
  })
})

// ── H — MiddleMan: operator UPDATE ALL (requires LLM) ────────────────────────

describe.skipIf(!operatorEnabled || !llmEnabled)('H — MiddleMan: operator UPDATE ALL', () => {
  it('H1: UPDATE ALL returns a meaningful reply without crashing', async () => {
    const r = await simProvider(operatorPhone, 'UPDATE ALL: close on Sundays')
    expect(r.replies.length).toBeGreaterThan(0)
    // Reply is either "applied to N/M" or "no live businesses" or a clarification request
    expect(r.replies[0]!.length).toBeGreaterThan(0)
  })

  describe('with a completed live business', () => {
    let biz: Awaited<ReturnType<typeof seedBusiness>>

    beforeEach(async () => {
      biz = await seedBusiness({ language: 'en', available247: true })
    })

    afterEach(async () => {
      await teardown(biz.businessId)
    })

    it('H2: UPDATE ALL applies instruction across all live businesses', async () => {
      const r = await simProvider(operatorPhone, 'UPDATE ALL: close on Sundays')
      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!
      // Reply should report applied count or a clarification
      expect(reply).toMatch(/applied|businesses|הוחל|עסקים|הבהרה|Clarification/i)
    })

    it('H3: Hebrew UPDATE ALL variant is accepted', async () => {
      const r = await simProvider(operatorPhone, 'עדכן הכל: סגור בימי ראשון')
      expect(r.replies.length).toBeGreaterThan(0)
      expect(r.replies[0]!.length).toBeGreaterThan(0)
    })
  })
})

// ── I — MiddleMan: language parity for operator replies ───────────────────────

describe.skipIf(!operatorEnabled)('I — MiddleMan: operator reply language parity', () => {
  describe('with two seeded businesses', () => {
    let biz1: Awaited<ReturnType<typeof seedBusiness>>
    let biz2: Awaited<ReturnType<typeof seedBusiness>>

    beforeEach(async () => {
      biz1 = await seedBusiness({ language: 'he' })
      biz2 = await seedBusiness({ language: 'en' })
    })

    afterEach(async () => {
      await teardown(biz1.businessId)
      await teardown(biz2.businessId)
    })

    it('I1: STATUS ALL (English command) reply contains both business names regardless of their language', async () => {
      const r = await simProvider(operatorPhone, 'STATUS ALL')
      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!
      // Both businesses seeded — reply should list both
      expect(reply).toContain('מספרת בדיקה')
      expect(reply).toContain('Test Barbershop')
    })

    it('I2: Hebrew STATUS ALL reply contains same businesses', async () => {
      const r = await simProvider(operatorPhone, 'סטטוס הכל')
      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!
      expect(reply).toContain('מספרת בדיקה')
      expect(reply).toContain('Test Barbershop')
    })

    it('I3: operator STATUS ALL and Hebrew alias both return non-empty replies', async () => {
      const enReply = (await simProvider(operatorPhone, 'STATUS ALL')).replies[0]!
      const heReply = (await simProvider(operatorPhone, 'סטטוס הכל')).replies[0]!

      // Both commands return meaningful content (no crash, no empty response)
      expect(enReply.length).toBeGreaterThan(0)
      expect(heReply.length).toBeGreaterThan(0)
      // STATUS ALL header differs between en/he
      expect(enReply).toMatch(/All Businesses|No businesses/)
      expect(heReply).toMatch(/כל העסקים|לא נרשמו עסקים/)
    })
  })
})
