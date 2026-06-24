import { describe, it, expect } from 'vitest'
import {
  resolveNotificationAction,
  upsertNotificationRule,
  removeNotificationRule,
} from './notification-rules.js'
import type { NotificationRule } from './notification-rules.js'
import type { NotificationPreferences } from '../../shared/skill-types.js'

const allTruePrefs: NotificationPreferences = {
  newBooking: true,
  firstTimeCustomer: true,
  cancellation: true,
  reschedule: true,
  noShow: true,
  upsetLanguage: true,
}

const allFalsePrefs: NotificationPreferences = {
  newBooking: false,
  firstTimeCustomer: false,
  cancellation: false,
  reschedule: false,
  noShow: false,
  upsetLanguage: false,
}

describe('resolveNotificationAction', () => {
  it('matching rule wins over legacy pref', () => {
    const rules: NotificationRule[] = [{ event: 'cancellation', action: 'handle_silently' }]
    // legacy says notify (true), rule says handle_silently → rule wins
    expect(resolveNotificationAction(rules, allTruePrefs, 'cancellation')).toBe('handle_silently')
  })

  it('no rule, legacy true → notify', () => {
    expect(resolveNotificationAction(null, allTruePrefs, 'new_booking')).toBe('notify')
  })

  it('no rule, legacy false → handle_silently', () => {
    expect(resolveNotificationAction(null, allFalsePrefs, 'new_booking')).toBe('handle_silently')
  })

  it('no rule, legacy prefs null → default notify', () => {
    expect(resolveNotificationAction(null, null, 'new_booking')).toBe('notify')
  })

  it('no rule, event with no legacy mapping (refund_request) → default notify', () => {
    expect(resolveNotificationAction(null, allFalsePrefs, 'refund_request')).toBe('notify')
  })

  it('windowed rule applies when hoursUntilEvent is within the window', () => {
    const rules: NotificationRule[] = [
      { event: 'cancellation', action: 'handle_silently', condition: { withinHours: 24 } },
    ]
    expect(resolveNotificationAction(rules, allTruePrefs, 'cancellation', { hoursUntilEvent: 12 })).toBe('handle_silently')
  })

  it('windowed rule does NOT match outside the window → falls back to legacy', () => {
    const rules: NotificationRule[] = [
      { event: 'cancellation', action: 'handle_silently', condition: { withinHours: 24 } },
    ]
    // 48h > 24h → rule does not match → legacy true → notify
    expect(resolveNotificationAction(rules, allTruePrefs, 'cancellation', { hoursUntilEvent: 48 })).toBe('notify')
  })

  it('windowed rule does NOT match when hours context is absent', () => {
    const rules: NotificationRule[] = [
      { event: 'cancellation', action: 'handle_silently', condition: { withinHours: 24 } },
    ]
    // no ctx → windowed rule needs context → falls back to legacy false → handle_silently
    expect(resolveNotificationAction(rules, allFalsePrefs, 'cancellation')).toBe('handle_silently')
  })

  it('notify_with_actions action passes through', () => {
    const rules: NotificationRule[] = [{ event: 'no_show', action: 'notify_with_actions' }]
    expect(resolveNotificationAction(rules, allFalsePrefs, 'no_show')).toBe('notify_with_actions')
  })
})

describe('upsertNotificationRule', () => {
  it('adds a new event', () => {
    const result = upsertNotificationRule(null, { event: 'new_booking', action: 'notify' })
    expect(result).toEqual([{ event: 'new_booking', action: 'notify' }])
  })

  it('replaces an existing same-event rule (length stays same, action updated)', () => {
    const existing: NotificationRule[] = [{ event: 'cancellation', action: 'notify' }]
    const result = upsertNotificationRule(existing, { event: 'cancellation', action: 'handle_silently' })
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ event: 'cancellation', action: 'handle_silently' })
  })

  it('preserves other events\' rules', () => {
    const existing: NotificationRule[] = [
      { event: 'new_booking', action: 'notify' },
      { event: 'cancellation', action: 'notify' },
    ]
    const result = upsertNotificationRule(existing, { event: 'cancellation', action: 'handle_silently' })
    expect(result).toHaveLength(2)
    expect(result).toContainEqual({ event: 'new_booking', action: 'notify' })
    expect(result).toContainEqual({ event: 'cancellation', action: 'handle_silently' })
  })
})

describe('removeNotificationRule', () => {
  it('removes the matching event', () => {
    const existing: NotificationRule[] = [
      { event: 'new_booking', action: 'notify' },
      { event: 'cancellation', action: 'notify' },
    ]
    const result = removeNotificationRule(existing, 'cancellation')
    expect(result).toEqual([{ event: 'new_booking', action: 'notify' }])
  })

  it('no-op when the event is absent', () => {
    const existing: NotificationRule[] = [{ event: 'new_booking', action: 'notify' }]
    const result = removeNotificationRule(existing, 'cancellation')
    expect(result).toEqual([{ event: 'new_booking', action: 'notify' }])
  })

  it('null input → []', () => {
    expect(removeNotificationRule(null, 'cancellation')).toEqual([])
  })
})
