import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// T1.4 — Branch 2 onboarding owner capture (decision 3). The MiddleMan onboarding infers the
// owner's gender from their Hebrew self-morphology, threads it into every onboarding reply, and
// persists it onto the manager identity at provisioning. Unknown → masculine floor.
const generateProviderOnboardingReply = vi.fn(async () => 'next onboarding message')
const explainOnboardingConcept = vi.fn(async () => null)

vi.mock('../../src/adapters/llm/client.js', () => ({
  generateProviderOnboardingReply: (...a: unknown[]) => generateProviderOnboardingReply(...a),
  explainOnboardingConcept: (...a: unknown[]) => explainOnboardingConcept(...a),
}))

import { handleProviderOnboarding, provisionBusiness } from '../../src/domain/flows/provider-onboarding.js'

// Minimal session-aware db: select returns the registered onboarding session row; update is a
// no-op that records nothing here (the flow persists collectedData, not asserted in this test).
function sessionDb(session: Record<string, unknown> | null): unknown {
  const chain: Record<string, unknown> = { then: (r: (v: unknown[]) => void) => r(session ? [session] : []) }
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy']) chain[m] = () => chain
  return {
    select: () => chain,
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'sess' }] }) }),
  }
}

beforeEach(() => {
  generateProviderOnboardingReply.mockClear()
  explainOnboardingConcept.mockClear()
})

function lastGender(): unknown {
  const c = (generateProviderOnboardingReply as Mock).mock.calls.at(-1)
  return (c?.[0] as { addresseeGender?: unknown } | undefined)?.addresseeGender
}

describe('onboarding infers + threads owner gender', () => {
  it('a female-morphology message makes the onboarding reply feminine', async () => {
    const session = {
      managerPhone: '+972500000000', step: 'timezone', completedAt: null,
      collectedData: { businessName: 'הסטודיו', language: 'he' },
    }
    // "אני מעוניינת..." is feminine self-morphology; the timezone is unparseable so the flow
    // takes the bad_timezone reply path — which still threads the resolved gender.
    await handleProviderOnboarding(sessionDb(session) as never, '+972500000000', 'אני מעוניינת להמשיך')
    expect(generateProviderOnboardingReply).toHaveBeenCalled()
    expect(lastGender()).toBe('female')
  })

  it('a neutral message leaves the reply masculine-floor (no gender threaded)', async () => {
    const session = {
      managerPhone: '+972500000000', step: 'timezone', completedAt: null,
      collectedData: { businessName: 'הסטודיו', language: 'he' },
    }
    await handleProviderOnboarding(sessionDb(session) as never, '+972500000000', 'jerusalem zone please')
    expect(lastGender()).toBeFalsy()
  })
})

describe('provisionBusiness persists the captured owner gender', () => {
  it('writes addresseeGender + source=self_morphology onto the manager identity', async () => {
    const inserts: Array<Record<string, unknown>> = []
    const db = {
      select: () => {
        const chain: Record<string, unknown> = { then: (r: (v: unknown[]) => void) => r([]) }
        for (const m of ['from', 'where', 'limit', 'orderBy']) chain[m] = () => chain
        return chain
      },
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserts.push(values)
          return { returning: async () => [{ id: 'biz-1' }] }
        },
      }),
    }
    const res = await provisionBusiness(db as never, '+972500000000', {
      businessName: 'הסטודיו', timezone: 'Asia/Jerusalem', phoneNumberId: 'pn', accessToken: 'tok',
      paPhoneNumber: '+972501112222', calendarMode: 'internal',
      ownerGender: 'female',
    } as never)
    expect(res).toEqual({ ok: true })
    const mgr = inserts.find((v) => (v as { role?: string }).role === 'manager')
    expect(mgr).toBeTruthy()
    expect(mgr).toMatchObject({ addresseeGender: 'female', addresseeGenderSource: 'self_morphology' })
  })
})
