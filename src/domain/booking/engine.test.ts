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

  it('is provider-agnostic by construction — providerId is not a parameter (arity is exactly 2)', () => {
    // Design invariant: the private conflict SELECT does NOT filter by providerId, so the
    // lock must be at least as coarse. We enforce this structurally rather than by value —
    // there is no provider argument the caller could pass that would split the lock. The
    // function signature is (businessId, slotStartIso) only, so its declared arity is 2.
    expect(privateBookingLockKey.length).toBe(2)

    // Therefore two booking requests for the same business + slot that differ ONLY in their
    // requested provider are forced through this same 2-arg call — provider is dropped before
    // the key is built — and collapse to one identical lock key. (Compare against the FINER
    // group-path key `${business}:${service}:${slot}` to make the agnosticism visible: ours
    // omits any third discriminator, so nothing provider-shaped can leak in.)
    const slot = '2026-07-01T10:00:00.000Z'
    expect(privateBookingLockKey('biz-123', slot)).toBe('biz-123:2026-07-01T10:00:00.000Z')
    // No extra colon-delimited segment beyond business + slot (slot itself contains colons,
    // so split on the businessId boundary): the key is exactly two logical fields.
    expect(privateBookingLockKey('biz-123', slot).startsWith('biz-123:')).toBe(true)
    expect(privateBookingLockKey('biz-123', slot).slice('biz-123:'.length)).toBe(slot)
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
