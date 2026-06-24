import { describe, it, expect } from 'vitest'
import { runGate } from './gate.js'
import type { GateInput } from './types.js'

// Baseline: an in-window, promotional, customer send that is allowed.
const base: GateInput = {
  audience: 'customer',
  consentClass: 'promotional',
  windowPolicy: { templateName: 'tmpl_x' },
  enabled: true,
  windowOpen: true,
  recipientOptedOut: false,
  nowInQuietHours: false,
}

describe('runGate — enable + dedup precedence', () => {
  it('disabled initiator is skipped before any other check', () => {
    expect(runGate({ ...base, enabled: false, windowOpen: false })).toEqual({
      kind: 'skip',
      reason: 'disabled',
    })
  })
})

describe('runGate — owner/operator audience (operational, ungated)', () => {
  it('owner send is always free-form, even out of window', () => {
    expect(runGate({ ...base, audience: 'owner', windowOpen: false, windowPolicy: 'skip' })).toEqual({
      kind: 'send_free_form',
    })
  })
  it('operator send ignores opt-out and quiet hours', () => {
    expect(
      runGate({ ...base, audience: 'operator', recipientOptedOut: true, nowInQuietHours: true, windowOpen: false }),
    ).toEqual({ kind: 'send_free_form' })
  })
})

describe('runGate — promotional consent checks', () => {
  it('opted-out promotional recipient is skipped', () => {
    expect(runGate({ ...base, recipientOptedOut: true })).toEqual({ kind: 'skip', reason: 'opted_out' })
  })
  it('quiet hours skip a promotional send', () => {
    expect(runGate({ ...base, nowInQuietHours: true })).toEqual({ kind: 'skip', reason: 'quiet_hours' })
  })
  it('transactional send bypasses opt-out and quiet hours', () => {
    expect(
      runGate({ ...base, consentClass: 'transactional', recipientOptedOut: true, nowInQuietHours: true }),
    ).toEqual({ kind: 'send_free_form' })
  })
})

describe('runGate — 24h window resolution', () => {
  it('in-window → free-form', () => {
    expect(runGate({ ...base, windowOpen: true })).toEqual({ kind: 'send_free_form' })
  })
  it('out-of-window with a template → send template', () => {
    expect(runGate({ ...base, windowOpen: false, windowPolicy: { templateName: 'appointment_reminder_24h' } })).toEqual({
      kind: 'send_template',
      templateName: 'appointment_reminder_24h',
    })
  })
  it('out-of-window with skip policy → skip', () => {
    expect(runGate({ ...base, windowOpen: false, windowPolicy: 'skip' })).toEqual({
      kind: 'skip',
      reason: 'outside_window_no_template',
    })
  })
})
