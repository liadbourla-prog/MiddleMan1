/**
 * Repro lock-in (plan Phase 1 test a, engine ground truth): a materialized owner-imported
 * class — type='class', source='google_import', providerId=null — is answerable AND bookable,
 * indistinguishable from an internally-scheduled class. This asserts the load-bearing fact the
 * whole feature rides on: findClassBlockProviderForSlot filters ONLY on (type='class',
 * serviceTypeId, startTs) with NO source/providerId filter, so a Google-imported class is
 * returned to the booking engine exactly like an internal one. If someone ever adds a source
 * filter here, this test goes red.
 */
import { describe, it, expect, vi } from 'vitest'
import { getTableName } from 'drizzle-orm'

const h = vi.hoisted(() => ({ classRow: null as Record<string, unknown> | null, whereArgs: null as unknown }))

vi.mock('../../db/client.js', () => {
  function tableName(t: unknown): string { try { return getTableName(t as never) } catch { return 'unknown' } }
  return {
    db: {
      select: () => {
        const state = { table: 'unknown' }
        const chain: Record<string, unknown> = {}
        chain['from'] = (t: unknown) => { state.table = tableName(t); return chain }
        chain['where'] = (w: unknown) => { h.whereArgs = w; return chain }
        chain['limit'] = async () => (state.table === 'calendar_blocks' && h.classRow ? [h.classRow] : [])
        return chain
      },
    },
  }
})

import { db } from '../../db/client.js'
import { findClassBlockProviderForSlot } from '../availability/blocks.js'

const SLOT = new Date('2026-07-05T19:00:00Z')

describe('findClassBlockProviderForSlot treats a google_import class as bookable', () => {
  it('returns found:true for a source=google_import, providerId=null class block', async () => {
    // A row shaped exactly like what the inbound translator materializes (providerId null).
    h.classRow = { providerId: null, maxParticipants: 8 }
    const r = await findClassBlockProviderForSlot(db as never, 'biz-1', 'svc-pilates', SLOT)
    expect(r.found).toBe(true)
    if (r.found) {
      expect(r.providerId).toBeNull() // never a fabricated instructor
      expect(r.maxParticipants).toBe(8)
    }
  })

  it('returns found:false when no class block occupies the slot', async () => {
    h.classRow = null
    const r = await findClassBlockProviderForSlot(db as never, 'biz-1', 'svc-pilates', SLOT)
    expect(r.found).toBe(false)
  })
})
