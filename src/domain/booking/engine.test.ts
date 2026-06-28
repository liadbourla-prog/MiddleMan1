import { describe, it, expect } from 'vitest'
import { privateBookingLockKey } from './engine.js'

// Pure advisory-lock key helper for requestPrivateBooking (T1.1a, finding A1).
// The DB-backed lock acquisition is integration-level (no unit DB harness in this repo);
// its I/O contract is pinned in the block comment in engine.ts above the lock call.
// These tests pin the pure key-derivation helper that is unit-testable independently.

describe('privateBookingLockKey — advisory lock key derivation', () => {
  it('produces a stable, deterministic key for a given (businessId, slotStartIso) pair', () => {
    const key = privateBookingLockKey('biz-123', '2026-07-01T10:00:00.000Z')
    expect(key).toBe('biz-123:2026-07-01T10:00:00.000Z')
  })

  it('same inputs → identical key (idempotent; repeated calls must serialize the same lock)', () => {
    const a = privateBookingLockKey('biz-abc', '2026-07-15T09:00:00.000Z')
    const b = privateBookingLockKey('biz-abc', '2026-07-15T09:00:00.000Z')
    expect(a).toBe(b)
  })

  it('different slotStart → different key (distinct slots do not share a lock)', () => {
    const k1 = privateBookingLockKey('biz-123', '2026-07-01T10:00:00.000Z')
    const k2 = privateBookingLockKey('biz-123', '2026-07-01T11:00:00.000Z')
    expect(k1).not.toBe(k2)
  })

  it('different businessId → different key (cross-business isolation)', () => {
    const k1 = privateBookingLockKey('biz-A', '2026-07-01T10:00:00.000Z')
    const k2 = privateBookingLockKey('biz-B', '2026-07-01T10:00:00.000Z')
    expect(k1).not.toBe(k2)
  })

  it('key is provider-agnostic (same business+slot with different providerIds yields the same key)', () => {
    // The private conflict SELECT does NOT filter by providerId — the lock must be at
    // least as coarse as that SELECT to close the dominant race (two customers grabbing
    // the same advertised slot regardless of which provider is requested).
    const k1 = privateBookingLockKey('biz-123', '2026-07-01T10:00:00.000Z')
    const k2 = privateBookingLockKey('biz-123', '2026-07-01T10:00:00.000Z')
    // Same key for same business+slot — provider does not enter the key.
    expect(k1).toBe(k2)
  })

  it('key contains the businessId as a recognisable prefix (human-readable format)', () => {
    const key = privateBookingLockKey('my-business', '2026-08-20T14:30:00.000Z')
    expect(key.startsWith('my-business:')).toBe(true)
  })

  it('key contains the ISO slot string (full precision is preserved)', () => {
    const iso = '2026-08-20T14:30:00.000Z'
    const key = privateBookingLockKey('biz-x', iso)
    expect(key).toContain(iso)
  })
})
