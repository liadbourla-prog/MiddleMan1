import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RESHUFFLE_CONFIG,
  resolveReshuffleConfig,
  isProtectedFromMove,
} from '../../src/domain/reshuffle/config.js'

describe('resolveReshuffleConfig', () => {
  it('returns the safe defaults for null/undefined (feature off, approval required, batches of 7)', () => {
    const c = resolveReshuffleConfig(null)
    expect(c).toEqual(DEFAULT_RESHUFFLE_CONFIG)
    expect(c.enabled).toBe(false)
    expect(c.approvalMode).toBe('require_approval')
    expect(c.batchSize).toBe(7)
    expect(c.protectWindowHours).toBe(3)
    expect(resolveReshuffleConfig(undefined)).toEqual(DEFAULT_RESHUFFLE_CONFIG)
  })

  it('merges a partial owner config over the defaults', () => {
    const c = resolveReshuffleConfig({ enabled: true, batchSize: 20, approvalMode: 'auto_apply' })
    expect(c.enabled).toBe(true)
    expect(c.batchSize).toBe(20)
    expect(c.approvalMode).toBe('auto_apply')
    expect(c.maxChainLength).toBe(DEFAULT_RESHUFFLE_CONFIG.maxChainLength) // untouched keys keep defaults
  })

  it('clamps nonsensical values and rejects bad enums', () => {
    const c = resolveReshuffleConfig({
      batchSize: -5, // → 0 (no cap)
      maxChainLength: 1, // → floor of 2 (a cycle needs at least 2 people)
      protectWindowHours: -1, // → 0
      approvalMode: 'whatever', // bad enum → default
      escalationLadder: ['direct', 'nonsense'], // filter invalid rungs
    })
    expect(c.batchSize).toBe(0)
    expect(c.maxChainLength).toBe(2)
    expect(c.protectWindowHours).toBe(0)
    expect(c.approvalMode).toBe('require_approval')
    expect(c.escalationLadder).toEqual(['direct'])
  })

  it('treats batchSize 0 / null as "no cap"', () => {
    expect(resolveReshuffleConfig({ batchSize: 0 }).batchSize).toBe(0)
    expect(resolveReshuffleConfig({ batchSize: null }).batchSize).toBe(0)
  })
})

describe('isProtectedFromMove (decision A4)', () => {
  const now = new Date('2026-06-23T08:00:00.000Z')
  const cfg = DEFAULT_RESHUFFLE_CONFIG

  it('protects a near-term booking within protectWindowHours', () => {
    const inTwoHours = new Date('2026-06-23T10:00:00.000Z') // 2h < default 3h
    expect(isProtectedFromMove({ slotStart: inTwoHours, vip: false, lastRescheduledAt: null }, cfg, now)).toBe(true)
  })

  it('does NOT protect a booking comfortably beyond the window', () => {
    const inSixHours = new Date('2026-06-23T14:00:00.000Z')
    expect(isProtectedFromMove({ slotStart: inSixHours, vip: false, lastRescheduledAt: null }, cfg, now)).toBe(false)
  })

  it('protects a VIP', () => {
    const later = new Date('2026-06-25T10:00:00.000Z')
    expect(isProtectedFromMove({ slotStart: later, vip: true, lastRescheduledAt: null }, cfg, now)).toBe(true)
  })

  it('protects someone who was rescheduled recently (within the lookback)', () => {
    const later = new Date('2026-06-25T10:00:00.000Z')
    const movedYesterday = new Date('2026-06-22T08:00:00.000Z')
    expect(isProtectedFromMove({ slotStart: later, vip: false, lastRescheduledAt: movedYesterday }, cfg, now)).toBe(true)
  })

  it('honors owner toggles (VIP protection off)', () => {
    const later = new Date('2026-06-25T10:00:00.000Z')
    const noVipProtect = resolveReshuffleConfig({ protectVip: false })
    expect(isProtectedFromMove({ slotStart: later, vip: true, lastRescheduledAt: null }, noVipProtect, now)).toBe(false)
  })

  it('respects an owner-widened protect window', () => {
    const inFourHours = new Date('2026-06-23T12:00:00.000Z')
    const wide = resolveReshuffleConfig({ protectWindowHours: 5 })
    expect(isProtectedFromMove({ slotStart: inFourHours, vip: false, lastRescheduledAt: null }, wide, now)).toBe(true)
  })
})
