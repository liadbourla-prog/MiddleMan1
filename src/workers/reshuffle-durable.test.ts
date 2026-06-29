/**
 * T1.10 — Durable send for reshuffle-campaign.ts sendProbe (E2/P7).
 *
 * Tests that sendProbe's executors (inside dispatchInitiation) call enqueueMessage —
 * so a transient failure throws (enabling dispatch.ts ledger compensation) rather than
 * being silently swallowed.
 *
 * vi.mock is hoisted — factories must not reference top-level variables.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── All mocks must be factory-only (no top-level variable refs) ───────────────

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
  // Make the chain both chainable AND directly awaitable (thenable) so that
  // "await db.select().from().where()" (no .limit) also resolves to an array.
  const chain: Record<string, unknown> = {}
  const rows = () => dbRows[dbQueryIdx++] ?? []
  chain['then'] = (resolve: (v: unknown) => void) => Promise.resolve(rows()).then(resolve)
  for (const m of ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'select']) {
    chain[m] = () => chain
  }
  chain['limit'] = async () => rows()
  return chain
}

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
    id: 'reshuffle.probe', audience: 'customer', consentClass: 'promotional',
    windowPolicy: 'skip', defaultEnabled: true, priority: 0,
  })),
}))

vi.mock('../adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}))

vi.mock('../domain/audit/logger.js', () => ({
  logAudit: vi.fn(async () => {}),
}))

vi.mock('../domain/reshuffle/config.js', () => ({
  resolveReshuffleConfig: vi.fn(() => ({
    offerTtlMinutes: 15,
    maxOutreachPerCampaign: 20,
    approvalMode: 'manual',
    escalationLadder: ['direct'],
    respectMessagingOptOut: true,
  })),
}))

vi.mock('../domain/reshuffle/campaign.js', () => ({
  assembleProposal: vi.fn(async () => ({ ok: false })),
}))

vi.mock('../domain/reshuffle/gate.js', () => ({
  approveProposal: vi.fn(async () => {}),
}))

vi.mock('../domain/reshuffle/worker-logic.js', () => ({
  selectBroadcastTargets: vi.fn(() => []),
  evaluateTermination: vi.fn(() => 'open'),
}))

vi.mock('../adapters/whatsapp/sender.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true })),
  sendTemplateMessage: vi.fn(async () => {}),
  canSendFreeForm: vi.fn(async () => true),
}))

// ── Imports after mocks ────────────────────────────────────────────────────────
import { processCampaignTick } from './reshuffle-campaign.js'
import * as messageRetry from './message-retry.js'
import * as dispatchMod from '../domain/initiations/dispatch.js'

// ── DB rows for processCampaignTick with the direct rung ──────────────────────
// processCampaignTick query order (direct rung, no solution yet):
//   1. campaign select (limit 1)
//   2. requester booking (limit 1)
//   3. business waCredentialsFor (limit 1)
//   4. occupant of target slot (limit 1) — direct rung
//   5. existing reshuffleOffer check (limit 1) → empty (not yet contacted)
//   6. reshuffleOffer insert returning
//   Then dispatchInitiation is called → sendFreeForm → enqueueMessage
//   7. open offers (no .limit, raw select) — use chain that returns []
//   8. buildCandidates bookings join → []
//   9. reshuffleOffers contacted → []
//   10. update outreachCount returning
//   evaluateTermination → 'open' (mocked)
//   reshuffleQueue.add tick (mocked)

function setupDirectRungRows() {
  dbQueryIdx = 0
  dbRows.length = 0

  // 1. campaign
  dbRows.push([{
    id: 'camp-1', status: 'searching', businessId: 'biz-1',
    requesterBookingId: 'bk-req', requesterId: 'cust-req',
    targetSlotStart: new Date('2026-07-01T10:00:00Z'),
    serviceTypeId: 'svc-1', outreachCount: 0, configSnapshot: {}, strategy: null,
  }])
  // 2. requester booking
  dbRows.push([{
    id: 'bk-req',
    slotStart: new Date('2026-07-01T09:00:00Z'),
    slotEnd: new Date('2026-07-01T10:00:00Z'),
  }])
  // 3. business
  dbRows.push([{
    name: 'Test Biz', timezone: 'Asia/Jerusalem', defaultLanguage: 'en',
    phoneNumberId: 'PNID', accessToken: 'TOKEN',
  }])
  // 4. occupant of target slot
  dbRows.push([{ bookingId: 'bk-occ', customerId: 'cust-occ', phoneNumber: '+972509999999' }])
  // 5. existing reshuffleOffer check → not yet contacted
  dbRows.push([])
  // 6. reshuffleOffer insert
  dbRows.push([{ id: 'offer-1' }])
  // dispatchInitiation (mocked) → sendFreeForm → enqueueMessage called here
  // 7. open offers
  dbRows.push([{ id: 'offer-1' }])
  // 8. buildCandidates bookings join
  dbRows.push([])
  // 9. reshuffleOffers contacted
  dbRows.push([])
  // 10. update outreachCount
  dbRows.push([])
}

describe('reshuffle sendProbe — executor calls enqueueMessage not sendMessage (E2/P7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDirectRungRows()
  })

  it('sendProbe free-form executor calls enqueueMessage with businessId + phoneNumber', async () => {
    await processCampaignTick('camp-1')

    expect(messageRetry.enqueueMessage).toHaveBeenCalledOnce()
    expect(messageRetry.enqueueMessage).toHaveBeenCalledWith(
      'biz-1',
      '+972509999999',
      expect.any(String),
    )
  })

  it('a failing enqueueMessage propagates — not swallowed — so dispatch compensation fires', async () => {
    vi.mocked(messageRetry.enqueueMessage).mockRejectedValueOnce(new Error('Redis unavailable'))

    // The dispatchInitiation stub calls sendFreeForm through; enqueueMessage throws;
    // dispatchInitiation re-throws; sendProbe re-throws; processCampaignTick re-throws.
    await expect(processCampaignTick('camp-1')).rejects.toThrow('Redis unavailable')

    expect(dispatchMod.dispatchInitiation).toHaveBeenCalledOnce()
    expect(messageRetry.enqueueMessage).toHaveBeenCalledOnce()
  })
})
