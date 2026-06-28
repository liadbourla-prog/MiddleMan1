/**
 * T1.10 — Durable send for waitlist.ts (E2/P7).
 *
 * Tests that:
 *   1. The standalone offer send (processJob offer_slot) uses enqueueMessage rather than
 *      sendMessage fire-and-forget — a transient WA failure is re-driven by BullMQ.
 *   2. A failing enqueueMessage propagates (not swallowed) so BullMQ job-level retry fires.
 *   3. Template path failures in the standalone offer propagate for job-level retry.
 *
 * vi.mock is hoisted — factories must not reference top-level variables.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── All mocks must be declared before any imports ─────────────────────────────

vi.mock('./message-retry.js', () => ({
  enqueueMessage: vi.fn(async () => {}),
}))

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(async () => ({ id: 'job-1' })),
  })),
}))

vi.mock('../redis.js', () => ({ redisConnection: {} }))

// db singleton — queries return rows from a shared array, consumed in call order.
let dbQueryIdx = 0
const dbRows: unknown[][] = []

vi.mock('../db/client.js', () => ({
  db: {
    select: () => makeSelectChain(),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => dbRows[dbQueryIdx++] ?? [],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => dbRows[dbQueryIdx++] ?? [],
        }),
        returning: async () => dbRows[dbQueryIdx++] ?? [],
      }),
    }),
    delete: () => ({ where: async () => { dbQueryIdx++; return [] } }),
  },
}))

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'select']) {
    chain[m] = () => chain
  }
  chain['limit'] = async () => dbRows[dbQueryIdx++] ?? []
  return chain
}

let freeFormAllowed = true

vi.mock('../adapters/whatsapp/sender.js', () => ({
  canSendFreeForm: vi.fn(async () => freeFormAllowed),
  sendMessage: vi.fn(async () => ({ ok: true })),
  sendTemplateMessage: vi.fn(async () => {}),
}))

vi.mock('../adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}))

vi.mock('../domain/audit/logger.js', () => ({
  logAudit: vi.fn(async () => {}),
}))

vi.mock('../domain/initiations/dispatch.js', () => ({
  dispatchInitiation: vi.fn(async (
    _db: unknown, _initiator: unknown, _ctx: unknown,
    exec: { sendFreeForm: () => Promise<void> },
  ) => {
    await exec.sendFreeForm()
    return { kind: 'send_free_form' }
  }),
}))

vi.mock('../domain/initiations/registry.js', () => ({
  getInitiator: vi.fn(() => ({
    id: 'coldfill.invite', audience: 'customer', consentClass: 'promotional',
    windowPolicy: 'skip', defaultEnabled: true, priority: 0, blastBreaker: undefined,
  })),
}))

vi.mock('../domain/initiations/blast-breaker.js', () => ({
  resolveBlastBreaker: vi.fn(() => ({ maxSent: 100, abortOnOptOutSpike: false, optOutSpikeThreshold: 1 })),
  evaluateBlastBreaker: vi.fn(() => 'continue'),
}))

vi.mock('../domain/crm/segment-repository.js', () => ({
  queryCustomerSegment: vi.fn(async () => []),
}))

vi.mock('../domain/crm/cold-fill.js', () => ({
  selectColdFillCandidates: vi.fn(() => []),
}))

vi.mock('../domain/i18n/t.js', () => ({
  i18n: { waitlist_offer: { en: () => 'A slot just opened.', he: () => 'נפתח מקום.' } },
}))

// ── Import module under test AFTER all mocks ───────────────────────────────────
import { processJob } from './waitlist.js'
import * as messageRetry from './message-retry.js'
import * as sender from '../adapters/whatsapp/sender.js'

// ── Helper: populate db rows for the offer_slot happy path ────────────────────
// Query order in processJob (offer_slot):
//   1. select next pending waitlist entry (limit 1)
//   2. CAS update returning (flip to 'offered')
//   3. customer identity (limit 1)
//   4. service (limit 1)
//   5. business (limit 1)
function setupOfferRows() {
  dbQueryIdx = 0
  dbRows.length = 0

  dbRows.push([{
    id: 'wl-1', customerId: 'cust-1', businessId: 'biz-1', serviceTypeId: 'svc-1',
    slotStart: new Date('2026-07-01T10:00:00Z'), status: 'pending',
  }])
  dbRows.push([{ id: 'wl-1' }]) // CAS won
  dbRows.push([{ phoneNumber: '+972501234567', preferredLanguage: 'en' }])
  dbRows.push([{ name: 'Haircut' }])
  dbRows.push([{
    name: 'Test Salon', timezone: 'Asia/Jerusalem', defaultLanguage: 'en',
    whatsappPhoneNumberId: 'PNID', whatsappAccessToken: 'TOKEN',
  }])
}

const JOB = {
  data: {
    type: 'offer_slot' as const,
    businessId: 'biz-1',
    serviceTypeId: 'svc-1',
    slotStart: new Date('2026-07-01T10:00:00Z').toISOString(),
    slotEnd: new Date('2026-07-01T11:00:00Z').toISOString(),
  },
}

describe('waitlist processJob — standalone offer uses enqueueMessage (E2/P7)', () => {
  beforeEach(() => {
    freeFormAllowed = true
    vi.clearAllMocks()
    setupOfferRows()
  })

  it('routes the free-form offer through enqueueMessage, not sendMessage directly', async () => {
    await processJob(JOB)

    expect(messageRetry.enqueueMessage).toHaveBeenCalledOnce()
    expect(messageRetry.enqueueMessage).toHaveBeenCalledWith(
      'biz-1',
      '+972501234567',
      expect.any(String),
    )
    // sendMessage must NOT be called directly
    expect(sender.sendMessage).not.toHaveBeenCalled()
  })

  it('a failing enqueueMessage propagates (not swallowed) so BullMQ retries the job', async () => {
    vi.mocked(messageRetry.enqueueMessage).mockRejectedValueOnce(new Error('Redis down'))

    await expect(processJob(JOB)).rejects.toThrow('Redis down')
  })

  it('template path failure propagates for job-level BullMQ retry', async () => {
    freeFormAllowed = false
    vi.mocked(sender.canSendFreeForm).mockResolvedValueOnce(false)
    vi.mocked(sender.sendTemplateMessage).mockRejectedValueOnce(new Error('WA API 503'))

    await expect(processJob(JOB)).rejects.toThrow('WA API 503')
  })
})
