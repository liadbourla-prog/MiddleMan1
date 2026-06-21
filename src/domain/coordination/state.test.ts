import { describe, it, expect } from 'vitest'
import { classifyContactReply, nextCoordinationState } from './state.js'
import type { Slot } from './types.js'

const c0: Slot = { start: new Date('2026-06-25T12:00:00Z'), end: new Date('2026-06-25T13:00:00Z') }
const c1: Slot = { start: new Date('2026-06-26T09:00:00Z'), end: new Date('2026-06-26T10:00:00Z') }
const candidates = [c0, c1]

describe('classifyContactReply', () => {
  it('maps an exact candidate-start match to accept', () => {
    const r = classifyContactReply({ start: new Date('2026-06-26T09:00:00Z'), end: new Date('2026-06-26T10:00:00Z') }, candidates)
    expect(r).toEqual({ kind: 'accept', candidateIndex: 1 })
  })
  it('treats a non-candidate proposed time as a counter', () => {
    const r = classifyContactReply({ start: new Date('2026-06-27T15:00:00Z'), end: new Date('2026-06-27T16:00:00Z') }, candidates)
    expect(r).toEqual({ kind: 'counter', slot: { start: new Date('2026-06-27T15:00:00Z'), end: new Date('2026-06-27T16:00:00Z') } })
  })
})

describe('nextCoordinationState — contact events', () => {
  it('accept → awaiting_owner_confirm + ping owner', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'contact_reply', reply: { kind: 'accept', candidateIndex: 0 }, candidates })
    expect(r.status).toBe('awaiting_owner_confirm')
    expect(r.effect).toEqual({ kind: 'ping_owner_confirm', slot: candidates[0] })
    expect(r.agreedSlot).toEqual(candidates[0])
  })
  it('counter → countered + relay to owner', () => {
    const slot = { start: new Date('2026-06-27T15:00:00Z'), end: new Date('2026-06-27T16:00:00Z') }
    const r = nextCoordinationState('awaiting_counterparty', { type: 'contact_reply', reply: { kind: 'counter', slot }, candidates })
    expect(r.status).toBe('countered')
    expect(r.effect).toEqual({ kind: 'relay_counter_to_owner', slot })
  })
  it('decline → declined + relay', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'contact_reply', reply: { kind: 'decline' }, candidates })
    expect(r.status).toBe('declined')
    expect(r.effect).toEqual({ kind: 'relay_decline_to_owner' })
  })
  it('unclear → no transition, no effect', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'contact_reply', reply: { kind: 'unclear' }, candidates })
    expect(r.status).toBe('awaiting_counterparty')
    expect(r.effect).toEqual({ kind: 'none' })
  })
})

describe('nextCoordinationState — owner decisions', () => {
  it('confirm from awaiting_owner_confirm → confirmed + book', () => {
    const r = nextCoordinationState('awaiting_owner_confirm', { type: 'owner_decision', decision: { kind: 'confirm' }, agreedSlot: candidates[0]!, candidates })
    expect(r.status).toBe('confirmed')
    expect(r.effect).toEqual({ kind: 'book_and_notify', slot: candidates[0]! })
  })
  it('confirm from countered → confirmed + book the countered slot', () => {
    const slot = { start: new Date('2026-06-27T15:00:00Z'), end: new Date('2026-06-27T16:00:00Z') }
    const r = nextCoordinationState('countered', { type: 'owner_decision', decision: { kind: 'confirm' }, agreedSlot: slot, candidates })
    expect(r.status).toBe('confirmed')
    expect(r.effect).toEqual({ kind: 'book_and_notify', slot })
  })
  it('counter_offer → awaiting_counterparty + send new candidate', () => {
    const slot = { start: new Date('2026-06-28T11:00:00Z'), end: new Date('2026-06-28T12:00:00Z') }
    const r = nextCoordinationState('countered', { type: 'owner_decision', decision: { kind: 'counter_offer', slot }, candidates })
    expect(r.status).toBe('awaiting_counterparty')
    expect(r.effect).toEqual({ kind: 'message_contact_new_candidate', slot })
  })
  it('abandon → abandoned', () => {
    const r = nextCoordinationState('countered', { type: 'owner_decision', decision: { kind: 'abandon' }, candidates })
    expect(r.status).toBe('abandoned')
    expect(r.effect).toEqual({ kind: 'none' })
  })
  it('confirm from awaiting_counterparty (stale agreedSlot) is a safe no-op — never books', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'owner_decision', decision: { kind: 'confirm' }, agreedSlot: c0, candidates })
    expect(r.status).toBe('awaiting_counterparty')
    expect(r.effect).toEqual({ kind: 'none' })
  })
})

describe('nextCoordinationState — expiry', () => {
  it('expiry from awaiting_counterparty → expired + notify owner', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'expire' })
    expect(r.status).toBe('expired')
    expect(r.effect).toEqual({ kind: 'notify_owner_expired' })
  })
})
