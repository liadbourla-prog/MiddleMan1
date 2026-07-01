/**
 * T1.1 — title→service matcher (pure, unit-testable).
 *
 * Normalizes an owner event's title and matches it against the business's
 * `service_types.name`. Returns { serviceTypeId, schedulingMode, defaultCapacity }
 * on a match, or null on any non-service title — the null is the PRIVACY GATE that
 * preserves decision #10 (a personal event never becomes a class because its title
 * never matches a defined service name).
 *
 * No DB (DATABASE_URL unset) — a table-name-aware `db` mock returns a scripted
 * service_types list, same spirit as inbound-sync-reconcile.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { normalizeServiceTitle, matchTitleToService } from './service-match.js'

function dbWithServices(services: Array<Record<string, unknown>>) {
  return {
    select: () => {
      const chain: Record<string, unknown> = {}
      chain['from'] = () => chain
      chain['where'] = () => chain
      chain['then'] = (resolve: (v: unknown) => unknown) => resolve(services)
      return chain
    },
  }
}

describe('normalizeServiceTitle', () => {
  it('trims, lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeServiceTitle('  Pilates!  ')).toBe('pilates')
    expect(normalizeServiceTitle('PILATES')).toBe('pilates')
    expect(normalizeServiceTitle('פילאטיס  ')).toBe('פילאטיס')
  })

  it('folds Hebrew niqqud (diacritics)', () => {
    // "פִּילָאטִיס" with niqqud normalizes to bare "פילאטיס"
    expect(normalizeServiceTitle('פִּילָאטִיס')).toBe(normalizeServiceTitle('פילאטיס'))
  })

  it('returns empty string for a blank title', () => {
    expect(normalizeServiceTitle('   ')).toBe('')
    expect(normalizeServiceTitle('')).toBe('')
  })
})

describe('matchTitleToService', () => {
  const SERVICES = [
    { id: 'svc-pilates', name: 'פילאטיס', schedulingMode: 'class', maxParticipants: 8 },
    { id: 'svc-massage', name: 'Massage', schedulingMode: 'appointment', maxParticipants: 1 },
  ]

  it('matches an exact-normalized Hebrew service name', async () => {
    const db = dbWithServices(SERVICES)
    const m = await matchTitleToService(db as never, 'biz-1', 'פילאטיס')
    expect(m).toEqual({ serviceTypeId: 'svc-pilates', schedulingMode: 'class', defaultCapacity: 8 })
  })

  it('matches when the title CONTAINS the service name as a token ("Pilates class")', async () => {
    const db = dbWithServices(SERVICES)
    const m = await matchTitleToService(db as never, 'biz-1', 'פילאטיס ערב')
    expect(m?.serviceTypeId).toBe('svc-pilates')
  })

  it('matches an appointment-mode service and carries its mode + capacity', async () => {
    const db = dbWithServices(SERVICES)
    const m = await matchTitleToService(db as never, 'biz-1', 'massage')
    expect(m).toEqual({ serviceTypeId: 'svc-massage', schedulingMode: 'appointment', defaultCapacity: 1 })
  })

  it('returns null on a non-service title (privacy gate) — "dentist", "lunch", ""', async () => {
    const db = dbWithServices(SERVICES)
    expect(await matchTitleToService(db as never, 'biz-1', 'דנטיסט')).toBeNull()
    expect(await matchTitleToService(db as never, 'biz-1', 'lunch')).toBeNull()
    expect(await matchTitleToService(db as never, 'biz-1', '')).toBeNull()
    expect(await matchTitleToService(db as never, 'biz-1', null)).toBeNull()
  })

  it('does NOT over-match a service name that is only a partial substring of a word', async () => {
    const db = dbWithServices([{ id: 'svc-yoga', name: 'yoga', schedulingMode: 'class', maxParticipants: 10 }])
    // "yogurt" contains the letters of "yoga"? no — but guard the token-boundary rule:
    // "yogalates" must NOT match "yoga" (not a whole token).
    expect(await matchTitleToService(db as never, 'biz-1', 'yogalates')).toBeNull()
  })
})
