import { describe, it, expect } from 'vitest'
import { buildRestoreDraft } from '../../src/domain/flows/customer-booking.js'

// P4: the pure restore decision. A fresh snapshot of a future slot for an active service
// becomes a draft; anything stale, past, malformed, or for a removed service → null
// (the handler then falls through to ordinary handling).
const TZ = 'Asia/Jerusalem'
const NOW = new Date('2026-06-28T10:00:00Z') // Sun 13:00 IL
const FUTURE = '2026-06-30T11:00:00Z'        // Tue 14:00 IL (the cancelled pilates)
const services = new Set(['pil'])

const snap = { serviceTypeId: 'pil', serviceName: 'פילאטיס', slotStartIso: FUTURE }

describe('buildRestoreDraft', () => {
  it('builds a draft for a fresh, future, active-service snapshot', () => {
    const at = new Date(NOW.getTime() - 5 * 60_000) // cancelled 5 min ago
    const d = buildRestoreDraft(snap, at, NOW, 120, services, TZ)
    expect(d).not.toBeNull()
    expect(d!.serviceTypeId).toBe('pil')
    expect(d!.dateStr).toBe('2026-06-30')
    expect(d!.time).toEqual({ hour: 14, minute: 0 }) // 11:00Z = 14:00 IL
  })

  it('returns null when the snapshot is older than the freshness window', () => {
    const at = new Date(NOW.getTime() - 200 * 60_000) // 200 min ago, window 120
    expect(buildRestoreDraft(snap, at, NOW, 120, services, TZ)).toBeNull()
  })

  it('returns null when the cancelled slot is now in the past', () => {
    const pastSnap = { ...snap, slotStartIso: '2026-06-27T11:00:00Z' } // before NOW
    const at = new Date(NOW.getTime() - 5 * 60_000)
    expect(buildRestoreDraft(pastSnap, at, NOW, 120, services, TZ)).toBeNull()
  })

  it('returns null when the service is no longer active', () => {
    const at = new Date(NOW.getTime() - 5 * 60_000)
    expect(buildRestoreDraft(snap, at, NOW, 120, new Set(['other']), TZ)).toBeNull()
  })

  it('returns null on a malformed slot timestamp', () => {
    const bad = { ...snap, slotStartIso: 'not-a-date' }
    const at = new Date(NOW.getTime() - 5 * 60_000)
    expect(buildRestoreDraft(bad, at, NOW, 120, services, TZ)).toBeNull()
  })
})
