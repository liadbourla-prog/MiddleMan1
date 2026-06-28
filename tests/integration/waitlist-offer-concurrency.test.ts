// Integration concurrency proof for T1.6: CAS-based atomic FIFO promotion in the
// waitlist worker (finding E1, root P1).
//
// Skips when DATABASE_URL is absent (no local Postgres in this repo's CI environment).
// Run with a real DB: DATABASE_URL=<dsn> npm run test:integration
//
// WHAT THIS PROVES:
//   Two concurrent offer_slot jobs for the same pending waitlist entry fire via
//   Promise.all. The CAS UPDATE (WHERE id = ? AND status = 'pending') forces exactly
//   one job to flip the row to 'offered' (rowsFlipped === 1); the other gets 0 rows
//   back (rowsFlipped === 0) and must NOT send — so offer sends fire exactly once.
//
// Without the CAS (bare WHERE id = ?) both jobs promote the row and both send —
// the same customer receives two offers for the same slot (double-offer bug E1).

import { vi } from 'vitest'

vi.mock('../../src/redis.js', () => ({
  redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBookingMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined),
  startCalendarMirrorWorker: vi.fn(),
}))

// Capture send calls so we can assert exactly-once semantics.
const sendMessage = vi.fn().mockResolvedValue({ ok: true })
const sendTemplateMessage = vi.fn().mockResolvedValue({ ok: true })
const canSendFreeForm = vi.fn().mockResolvedValue(false) // use template path (simpler, no LLM)

vi.mock('../../src/adapters/whatsapp/sender.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  sendTemplateMessage: (...a: unknown[]) => sendTemplateMessage(...a),
  canSendFreeForm: (...a: unknown[]) => canSendFreeForm(...a),
}))
vi.mock('../../src/adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn(async (i: { fallback: string }) => i.fallback),
}))
// Stub the expiry-job enqueue so offer_slot doesn't need a live BullMQ queue.
vi.mock('../../src/workers/waitlist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workers/waitlist.js')>()
  return {
    ...actual,
    waitlistQueue: { add: vi.fn().mockResolvedValue(undefined) },
  }
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { waitlist } from '../../src/db/schema.js'
import { seedBusiness, seedCustomer, teardown, integrationEnabled, freshPhone } from './setup.js'
import type { TestBusiness } from './setup.js'

// processJob is not exported by default; import the module under test and reach in via
// the exported Worker factory — but the cleanest approach for white-box testing is to
// import the internal handler directly. Since processJob is not exported we re-import
// the whole module in a way that lets us call triggerWaitlistForSlot / the handler.
// Instead, we exercise the logic through a thin re-export shim created for tests, or
// we call the handler directly by importing the module with the queue mocked above.
//
// The cleanest path: export processJob from waitlist.ts. Since the task says to write
// the test TEST-FIRST and implementation together, we import it here and it must be
// exported by the worker. We do this by importing with dynamic import after mocks are set.

const slot = (() => {
  const slotStart = new Date()
  slotStart.setUTCDate(slotStart.getUTCDate() + 7)
  slotStart.setUTCHours(10, 0, 0, 0)
  const slotEnd = new Date(slotStart.getTime() + 60 * 60_000)
  return { slotStart, slotEnd }
})()

const d = describe.skipIf(!integrationEnabled)

d('T1.6 — waitlist CAS promotion (no double-offer)', () => {
  let biz: TestBusiness
  let customerId: string
  let waitlistId: string
  // Loaded dynamically after mocks are installed.
  let processWaitlistJob: (job: { data: {
    type: 'offer_slot' | 'expire_offer'
    businessId: string
    serviceTypeId: string
    slotStart: string
    slotEnd: string
    waitlistId?: string
  } }) => Promise<void>

  beforeEach(async () => {
    vi.clearAllMocks()
    canSendFreeForm.mockResolvedValue(false)

    biz = await seedBusiness({ calendarMode: 'internal', language: 'en' })
    customerId = await seedCustomer(biz.businessId, freshPhone())

    // Seed ONE pending waitlist entry for a future slot.
    const [entry] = await db
      .insert(waitlist)
      .values({
        businessId: biz.businessId,
        serviceTypeId: biz.serviceId,
        customerId,
        slotStart: slot.slotStart,
        slotEnd: slot.slotEnd,
        status: 'pending',
      })
      .returning({ id: waitlist.id })

    if (!entry) throw new Error('waitlist seed failed')
    waitlistId = entry.id

    // Import after mocks are registered.
    const mod = await import('../../src/workers/waitlist.js')
    // processJob is exported for testing purposes (see waitlist.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    processWaitlistJob = (mod as any).processJob
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  it('two concurrent offer_slot jobs for the same entry send exactly one offer', async () => {
    const jobData = {
      type: 'offer_slot' as const,
      businessId: biz.businessId,
      serviceTypeId: biz.serviceId,
      slotStart: slot.slotStart.toISOString(),
      slotEnd: slot.slotEnd.toISOString(),
    }

    // Fire both concurrently — this is the race that E1 describes.
    await Promise.all([
      processWaitlistJob({ data: jobData }),
      processWaitlistJob({ data: jobData }),
    ])

    // Only ONE send (template or free-form) must have been dispatched.
    const totalSends = sendMessage.mock.calls.length + sendTemplateMessage.mock.calls.length
    expect(totalSends).toBe(1)

    // Exactly one waitlist row must be in 'offered' state.
    const rows = await db
      .select({ status: waitlist.status })
      .from(waitlist)
      .where(and(eq(waitlist.id, waitlistId)))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('offered')
  })
})
