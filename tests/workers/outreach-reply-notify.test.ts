import { describe, it, expect } from 'vitest'
import { pickPendingOutreach, filterDeliverableDeferrals } from '../../src/workers/outreach-reply-notify.js'

const HOUR = 60 * 60_000
const WINDOW = 48 * HOUR
const now = new Date('2026-06-21T12:00:00Z')

function row(id: string, agoHours: number, entityId = 'cust-1') {
  return { id, entityId, createdAt: new Date(now.getTime() - agoHours * HOUR) }
}

describe('pickPendingOutreach', () => {
  it('returns the outreach when a reply arrives within the window and nothing handled it', () => {
    const picked = pickPendingOutreach([row('sent-1', 2)], [], now, WINDOW)
    expect(picked?.id).toBe('sent-1')
  })

  it('returns null when there is no outreach at all', () => {
    expect(pickPendingOutreach([], [], now, WINDOW)).toBeNull()
  })

  it('returns null when the outreach is older than the reply window', () => {
    expect(pickPendingOutreach([row('sent-old', 49)], [], now, WINDOW)).toBeNull()
  })

  it('picks the most recent outreach within window when several exist', () => {
    const picked = pickPendingOutreach([row('sent-old', 40), row('sent-new', 3)], [], now, WINDOW)
    expect(picked?.id).toBe('sent-new')
  })

  it('returns null when a notification was already sent after the outreach (dedupe)', () => {
    const sent = [row('sent-1', 5)]
    const handled = [{ id: 'notif-1', entityId: 'cust-1', createdAt: new Date(now.getTime() - 4 * HOUR) }]
    expect(pickPendingOutreach(sent, handled, now, WINDOW)).toBeNull()
  })

  it('returns null when the outreach was deferred (handled, awaiting requester)', () => {
    const sent = [row('sent-1', 5)]
    const handled = [{ id: 'deferred-1', entityId: 'cust-1', createdAt: new Date(now.getTime() - 5 * HOUR + 1000) }]
    expect(pickPendingOutreach(sent, handled, now, WINDOW)).toBeNull()
  })

  it('re-arms when a NEWER outreach follows an older handled one', () => {
    const sent = [row('sent-old', 10), row('sent-new', 1)]
    // marker handled the OLD outreach; the new one is still pending
    const handled = [{ id: 'notif-old', entityId: 'cust-1', createdAt: new Date(now.getTime() - 9 * HOUR) }]
    const picked = pickPendingOutreach(sent, handled, now, WINDOW)
    expect(picked?.id).toBe('sent-new')
  })
})

describe('filterDeliverableDeferrals', () => {
  const MAX_AGE = 168 * HOUR

  it('returns a deferral that has not been notified yet', () => {
    const out = filterDeliverableDeferrals([row('def-1', 2)], [], now, MAX_AGE)
    expect(out.map((r) => r.id)).toEqual(['def-1'])
  })

  it('drops a deferral already superseded by a later notification for that customer', () => {
    const deferred = [row('def-1', 5, 'cust-1')]
    const notified = [{ id: 'notif-1', entityId: 'cust-1', createdAt: new Date(now.getTime() - 4 * HOUR) }]
    expect(filterDeliverableDeferrals(deferred, notified, now, MAX_AGE)).toEqual([])
  })

  it('keeps a deferral when an unrelated customer was notified', () => {
    const deferred = [row('def-1', 5, 'cust-1')]
    const notified = [{ id: 'notif-2', entityId: 'cust-2', createdAt: new Date(now.getTime() - 4 * HOUR) }]
    expect(filterDeliverableDeferrals(deferred, notified, now, MAX_AGE).map((r) => r.id)).toEqual(['def-1'])
  })

  it('drops a stale deferral older than the max age', () => {
    expect(filterDeliverableDeferrals([row('def-old', 169)], [], now, MAX_AGE)).toEqual([])
  })

  it('returns deliverable deferrals newest-first', () => {
    const out = filterDeliverableDeferrals(
      [row('def-a', 10, 'cust-1'), row('def-b', 2, 'cust-2')],
      [],
      now,
      MAX_AGE,
    )
    expect(out.map((r) => r.id)).toEqual(['def-b', 'def-a'])
  })
})
