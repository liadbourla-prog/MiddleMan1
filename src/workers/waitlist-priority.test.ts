/**
 * WL-2a — Priority tiering in FIFO promotion (workers/waitlist.ts offer_slot).
 *
 * Proves the SELECTION change: given two pending entries where the FIFO-first one HAS a
 * commitment in the next-7-days window and the second does NOT, offer_slot offers the SECOND
 * (priority, no-commitment) customer — i.e. the row flipped to 'offered' and the message/audit
 * are for that customer, not the earlier-joined-but-committed one.
 *
 * Harness mirrors waitlist-durable.test.ts: a sequential-row db mock consumed in call order.
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

vi.mock('./waitlist-revalidate.js', () => ({
  revalidateWaitlistSlotOpen: vi.fn(async () => true),
}))

// db singleton — select queries return rows from a shared array, consumed in call order;
// update()...returning() consumes from the SAME array so CAS results stay interleaved.
let dbQueryIdx = 0
const dbRows: unknown[][] = []
// Capture each CAS update's WHERE-targeted row id (recorded via the proxy below).
const capturedUpdateSets: unknown[] = []

vi.mock('../db/client.js', () => ({
  db: {
    select: () => makeSelectChain(),
    update: () => ({
      set: (vals: unknown) => {
        capturedUpdateSets.push(vals)
        return {
          where: () => ({
            returning: async () => dbRows[dbQueryIdx++] ?? [],
          }),
        }
      },
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: async () => dbRows[dbQueryIdx++] ?? [] }),
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
  // A select resolved without .limit() (the load-ALL-pending query) is awaited on the chain.
  chain['then'] = (resolve: (v: unknown) => unknown) => resolve(dbRows[dbQueryIdx++] ?? [])
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

const auditCalls: { action: string; entityId: string; metadata: unknown }[] = []
vi.mock('../domain/audit/logger.js', () => ({
  logAudit: vi.fn(async (_db: unknown, entry: { action: string; entityId: string; metadata: unknown }) => {
    auditCalls.push({ action: entry.action, entityId: entry.entityId, metadata: entry.metadata })
  }),
}))

vi.mock('../domain/initiations/dispatch.js', () => ({
  dispatchInitiation: vi.fn(async () => ({ kind: 'noop' })),
}))
vi.mock('../domain/initiations/registry.js', () => ({ getInitiator: vi.fn(() => undefined) }))
vi.mock('../domain/initiations/blast-breaker.js', () => ({
  resolveBlastBreaker: vi.fn(() => ({})),
  evaluateBlastBreaker: vi.fn(() => 'continue'),
}))
vi.mock('../domain/crm/segment-repository.js', () => ({ queryCustomerSegment: vi.fn(async () => []) }))
vi.mock('../domain/crm/cold-fill.js', () => ({ selectColdFillCandidates: vi.fn(() => []) }))

vi.mock('../domain/i18n/t.js', () => ({
  i18n: { waitlist_offer: { en: () => 'A slot just opened.', he: () => 'נפתח מקום.' } },
}))

// ── Import module under test AFTER all mocks ───────────────────────────────────
import { processJob } from './waitlist.js'
import * as messageRetry from './message-retry.js'

const SLOT = new Date('2026-07-01T10:00:00Z')
const JOB = {
  data: {
    type: 'offer_slot' as const,
    businessId: 'biz-1',
    serviceTypeId: 'svc-1',
    slotStart: SLOT.toISOString(),
    slotEnd: new Date('2026-07-01T11:00:00Z').toISOString(),
  },
}

describe('waitlist offer_slot — priority tiering (WL-2a)', () => {
  beforeEach(() => {
    freeFormAllowed = true
    dbQueryIdx = 0
    dbRows.length = 0
    capturedUpdateSets.length = 0
    auditCalls.length = 0
    vi.clearAllMocks()
  })

  it('offers the no-commitment (priority) customer over the earlier-joined committed one', async () => {
    // Query order in the NEW offer_slot selection:
    //  1. load ALL pending entries (createdAt asc)  → [committed-first, no-commitment-second]
    //  2. per-candidate active-booking-in-window lookup — A (committed) → 1 row
    //  3. per-candidate active-booking-in-window lookup — B (no commitment) → 0 rows
    //  4. CAS update returning (flip winner=B to 'offered') → 1 row
    //  5. customer identity (limit 1)
    //  6. service (limit 1)
    //  7. business (limit 1)
    dbRows.push([
      { id: 'wl-A', customerId: 'cust-A', businessId: 'biz-1', serviceTypeId: 'svc-1', slotStart: SLOT, createdAt: new Date('2026-06-28T09:00:00Z'), status: 'pending' },
      { id: 'wl-B', customerId: 'cust-B', businessId: 'biz-1', serviceTypeId: 'svc-1', slotStart: SLOT, createdAt: new Date('2026-06-29T09:00:00Z'), status: 'pending' },
    ])
    dbRows.push([{ id: 'bk-A' }]) // A has a commitment in window
    dbRows.push([]) // B has none → priority
    dbRows.push([{ id: 'wl-B' }]) // CAS won for B
    dbRows.push([{ phoneNumber: '+972500000002', preferredLanguage: 'en' }]) // cust-B
    dbRows.push([{ name: 'Haircut' }])
    dbRows.push([{ name: 'Test Salon', timezone: 'Asia/Jerusalem', defaultLanguage: 'en', whatsappPhoneNumberId: 'PNID', whatsappAccessToken: 'TOKEN' }])

    await processJob(JOB)

    // Winner is B (priority): the CAS flip set 'offered' and the send went to cust-B's phone.
    expect(capturedUpdateSets.some((s) => (s as { status?: string }).status === 'offered')).toBe(true)
    expect(messageRetry.enqueueMessage).toHaveBeenCalledWith('biz-1', '+972500000002', expect.any(String))

    // Audit records the winning entry with tier 'priority'.
    const sent = auditCalls.find((a) => a.action === 'waitlist.offer_sent')
    expect(sent?.entityId).toBe('wl-B')
    expect((sent?.metadata as { tier?: string }).tier).toBe('priority')
  })

  it('on a CAS loss for the top candidate, re-ranks and offers the next', async () => {
    //  1. load ALL pending: [B (no commitment, top), A (committed)]
    //  2. booking lookup B → none → tier priority
    //  3. booking lookup A → 1 row → tier normal
    //  4. CAS for B → 0 rows (concurrent job took it)
    //  5. CAS for A → 1 row (won)
    //  6. customer identity (A)
    //  7. service
    //  8. business
    dbRows.push([
      { id: 'wl-B', customerId: 'cust-B', businessId: 'biz-1', serviceTypeId: 'svc-1', slotStart: SLOT, createdAt: new Date('2026-06-29T09:00:00Z'), status: 'pending' },
      { id: 'wl-A', customerId: 'cust-A', businessId: 'biz-1', serviceTypeId: 'svc-1', slotStart: SLOT, createdAt: new Date('2026-06-28T09:00:00Z'), status: 'pending' },
    ])
    dbRows.push([]) // B none → priority (ranks first)
    dbRows.push([{ id: 'bk-A' }]) // A committed → normal
    dbRows.push([]) // CAS B lost
    dbRows.push([{ id: 'wl-A' }]) // CAS A won
    dbRows.push([{ phoneNumber: '+972500000001', preferredLanguage: 'en' }]) // cust-A
    dbRows.push([{ name: 'Haircut' }])
    dbRows.push([{ name: 'Test Salon', timezone: 'Asia/Jerusalem', defaultLanguage: 'en', whatsappPhoneNumberId: 'PNID', whatsappAccessToken: 'TOKEN' }])

    await processJob(JOB)

    expect(messageRetry.enqueueMessage).toHaveBeenCalledWith('biz-1', '+972500000001', expect.any(String))
    const sent = auditCalls.find((a) => a.action === 'waitlist.offer_sent')
    expect(sent?.entityId).toBe('wl-A')
    expect((sent?.metadata as { tier?: string }).tier).toBe('normal')
  })

  it('no pending entries → falls through to cold-fill, no offer sent', async () => {
    dbRows.push([]) // load-all pending → empty
    await processJob(JOB)
    expect(messageRetry.enqueueMessage).not.toHaveBeenCalled()
    expect(auditCalls.find((a) => a.action === 'waitlist.offer_sent')).toBeUndefined()
  })
})
