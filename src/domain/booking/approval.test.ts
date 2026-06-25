import { describe, it, expect } from 'vitest'
import {
  shouldHoldForApproval,
  nextApprovalResolution,
  isApprovalExpiry,
  selectPendingApproval,
  type PendingApprovalCandidate,
} from './approval.js'
import type { BookingState } from '../../db/schema.js'

// Pure decision cores for per-service owner approval of customer self-bookings
// (design 2026-06-25). The DB-backed resolveBookingApproval is integration-level (no unit DB
// harness in this repo); its I/O contract is pinned in the block comment in approval.ts. These
// tests pin the pure cores the engine gate, the hold-expiry worker, and the orchestrator tool reuse.

describe('shouldHoldForApproval — never-default engine gate', () => {
  it('flag off → never gated, regardless of caller (today\'s path unchanged)', () => {
    expect(shouldHoldForApproval(false, 'customer')).toBe(false)
    expect(shouldHoldForApproval(false, 'manager')).toBe(false)
  })

  it('flag on + customer → gated (held for approval)', () => {
    expect(shouldHoldForApproval(true, 'customer')).toBe(true)
  })

  it('flag on + PA/owner-initiated (non-customer) → NOT gated (decision D1)', () => {
    expect(shouldHoldForApproval(true, 'manager')).toBe(false)
    expect(shouldHoldForApproval(true, 'delegated_user')).toBe(false)
    expect(shouldHoldForApproval(true, 'contact')).toBe(false)
    expect(shouldHoldForApproval(true, 'system')).toBe(false)
  })
})

describe('nextApprovalResolution — resolver transition decision', () => {
  it('approve, immediate gate → held→confirmed, approved', () => {
    expect(nextApprovalResolution('held', 'pending', 'approve', 'immediate')).toEqual({
      ok: true, targetState: 'confirmed', newApprovalStatus: 'approved',
    })
  })

  it('approve, payment-gated service → held→pending_payment, approved (approve-first-then-pay)', () => {
    expect(nextApprovalResolution('held', 'pending', 'approve', 'post_payment')).toEqual({
      ok: true, targetState: 'pending_payment', newApprovalStatus: 'approved',
    })
  })

  it('decline → held→cancelled, declined', () => {
    expect(nextApprovalResolution('held', 'pending', 'decline', 'immediate')).toEqual({
      ok: true, targetState: 'cancelled', newApprovalStatus: 'declined',
    })
    // payment gate is irrelevant to a decline
    expect(nextApprovalResolution('held', 'pending', 'decline', 'post_payment')).toEqual({
      ok: true, targetState: 'cancelled', newApprovalStatus: 'declined',
    })
  })

  it('already-resolved guard: only a held+pending request is resolvable (idempotent)', () => {
    // already approved/declined, expired, or a non-approval hold → no-op for both decisions
    const nonResolvable: Array<[BookingState, string | null]> = [
      ['confirmed', 'approved'],
      ['cancelled', 'declined'],
      ['pending_payment', 'approved'],
      ['expired', 'pending'],
      ['held', 'approved'], // marker already moved on
      ['held', null], // an ordinary (non-approval) hold
      ['requested', 'pending'],
    ]
    for (const [state, marker] of nonResolvable) {
      expect(nextApprovalResolution(state, marker, 'approve', 'immediate')).toEqual({ ok: false, reason: 'already_resolved' })
      expect(nextApprovalResolution(state, marker, 'decline', 'immediate')).toEqual({ ok: false, reason: 'already_resolved' })
    }
  })
})

describe('isApprovalExpiry — hold-expiry worker flavor', () => {
  it('a pending marker → approval-flavored expiry', () => {
    expect(isApprovalExpiry('pending')).toBe(true)
  })
  it('null / non-pending → ordinary short-TTL hold expiry', () => {
    expect(isApprovalExpiry(null)).toBe(false)
    expect(isApprovalExpiry('approved')).toBe(false)
    expect(isApprovalExpiry('declined')).toBe(false)
  })
})

describe('selectPendingApproval — free-text resolution mapping', () => {
  const mk = (over: Partial<PendingApprovalCandidate>): PendingApprovalCandidate => ({
    bookingId: 'b1', customerName: 'Dana', customerPhone: '+972500000001', serviceName: 'Yoga', slotLabel: 'Tue 3 Jun, 15:00', ...over,
  })

  it('no pending requests → none', () => {
    expect(selectPendingApproval([], {})).toEqual({ kind: 'none' })
  })

  it('exactly one pending + no hint → resolve it directly', () => {
    const c = mk({})
    expect(selectPendingApproval([c], {})).toEqual({ kind: 'one', booking: c })
  })

  it('explicit bookingId wins over hints', () => {
    const a = mk({ bookingId: 'a', customerName: 'Dana' })
    const b = mk({ bookingId: 'b', customerName: 'Dana' })
    expect(selectPendingApproval([a, b], { bookingId: 'b', customerHint: 'Dana' })).toEqual({ kind: 'one', booking: b })
  })

  it('explicit bookingId that matches nothing → none (do not fall back to guessing)', () => {
    expect(selectPendingApproval([mk({ bookingId: 'a' })], { bookingId: 'zzz' })).toEqual({ kind: 'none' })
  })

  it('disambiguates by customer name', () => {
    const dana = mk({ bookingId: 'a', customerName: 'Dana' })
    const yoni = mk({ bookingId: 'b', customerName: 'Yoni' })
    expect(selectPendingApproval([dana, yoni], { customerHint: 'yoni' })).toEqual({ kind: 'one', booking: yoni })
  })

  it('disambiguates by customer phone fragment', () => {
    const a = mk({ bookingId: 'a', customerName: null, customerPhone: '+972500000001' })
    const b = mk({ bookingId: 'b', customerName: null, customerPhone: '+972500000999' })
    expect(selectPendingApproval([a, b], { customerHint: '0999' })).toEqual({ kind: 'one', booking: b })
  })

  it('disambiguates by service when customers tie', () => {
    const yoga = mk({ bookingId: 'a', customerName: 'Dana', serviceName: 'Yoga' })
    const physio = mk({ bookingId: 'b', customerName: 'Dana', serviceName: 'Physio' })
    expect(selectPendingApproval([yoga, physio], { customerHint: 'Dana', serviceHint: 'physio' })).toEqual({ kind: 'one', booking: physio })
  })

  it('multiple pending + ambiguous reference → ask which (never guess)', () => {
    const a = mk({ bookingId: 'a', customerName: 'Dana' })
    const b = mk({ bookingId: 'b', customerName: 'Yoni' })
    const res = selectPendingApproval([a, b], {})
    expect(res.kind).toBe('ambiguous')
    if (res.kind === 'ambiguous') expect(res.candidates).toHaveLength(2)
  })

  it('hint that matches nothing → none', () => {
    expect(selectPendingApproval([mk({ customerName: 'Dana' })], { customerHint: 'Avi' })).toEqual({ kind: 'none' })
  })
})
