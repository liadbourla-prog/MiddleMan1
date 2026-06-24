import type { NotificationPreferences } from '../../shared/skill-types.js'

// Dynamic owner notification rules (Phase 5.5; design §7.7). A fixed event enum + simple conditions
// (no DSL, owner decision C). Rules layer ADDITIVELY over the legacy NotificationPreferences booleans
// (decision D): a matching rule wins; otherwise fall back to the legacy boolean for that event;
// otherwise a safe default of 'notify'. Pure — the dispatcher/notify sites and the Phase-6 trust
// ratchet consume resolveNotificationAction.

export type NotificationEvent =
  | 'new_booking' | 'first_time_customer' | 'cancellation' | 'reschedule'
  | 'no_show' | 'refund_request' | 'vip_return' | 'payment_received'

export type NotificationAction = 'notify' | 'notify_with_actions' | 'handle_silently'

export interface NotificationRule {
  event: NotificationEvent
  action: NotificationAction
  // Optional simple condition (no DSL). withinHours: the rule applies only when the event's
  // subject (e.g. the affected booking) is within this many hours — e.g. "only cancellations
  // inside 24h". Absent condition = always applies.
  condition?: { withinHours?: number }
}

export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  'new_booking', 'first_time_customer', 'cancellation', 'reschedule', 'no_show', 'refund_request', 'vip_return', 'payment_received',
]

// VOLUNTARY-OAU events (design §4, §7): the PA handles them fully autonomously, so the owner
// is NOT notified unless he explicitly opts in. For these the resolver defaults to
// handle_silently (rather than the surface-by-default 'notify') — honoring the North Star of
// driving the owner's involuntary attention toward zero. payments confirm themselves end to
// end; the owner sees them only if he set a rule. A matching rule still wins.
const VOLUNTARY_OAU_EVENTS: ReadonlySet<NotificationEvent> = new Set(['payment_received'])

// Map a fixed event to its legacy NotificationPreferences boolean (decision D fallback). Events
// with no legacy equivalent (refund_request, vip_return) return undefined → caller uses the default.
function legacyPrefFor(event: NotificationEvent, prefs: NotificationPreferences | null): boolean | undefined {
  if (!prefs) return undefined
  switch (event) {
    case 'new_booking': return prefs.newBooking
    case 'first_time_customer': return prefs.firstTimeCustomer
    case 'cancellation': return prefs.cancellation
    case 'reschedule': return prefs.reschedule
    case 'no_show': return prefs.noShow
    default: return undefined // refund_request, vip_return — no legacy boolean
  }
}

function conditionPasses(condition: NotificationRule['condition'], ctx: { hoursUntilEvent?: number } | undefined): boolean {
  if (!condition || condition.withinHours === undefined) return true
  if (ctx?.hoursUntilEvent === undefined) return false // a windowed rule needs the hours context
  return ctx.hoursUntilEvent <= condition.withinHours
}

/**
 * Resolve the owner-notification action for an event. A matching rule (whose condition passes)
 * wins; else fall back to the legacy NotificationPreferences boolean (true→notify, false→
 * handle_silently); else default to 'notify' (surface unknown events rather than hide them).
 */
export function resolveNotificationAction(
  rules: NotificationRule[] | null,
  legacyPrefs: NotificationPreferences | null,
  event: NotificationEvent,
  ctx?: { hoursUntilEvent?: number },
): NotificationAction {
  const rule = (rules ?? []).find((r) => r.event === event && conditionPasses(r.condition, ctx))
  if (rule) return rule.action
  const legacy = legacyPrefFor(event, legacyPrefs)
  if (legacy !== undefined) return legacy ? 'notify' : 'handle_silently'
  // Voluntary-OAU events default to silent (opt-in); all others surface by default.
  return VOLUNTARY_OAU_EVENTS.has(event) ? 'handle_silently' : 'notify'
}

/** Upsert a rule for an event (replace any existing rule for the same event). Pure. */
export function upsertNotificationRule(rules: NotificationRule[] | null, rule: NotificationRule): NotificationRule[] {
  const others = (rules ?? []).filter((r) => r.event !== rule.event)
  return [...others, rule]
}

/** Remove the rule for an event (if any). Pure. */
export function removeNotificationRule(rules: NotificationRule[] | null, event: NotificationEvent): NotificationRule[] {
  return (rules ?? []).filter((r) => r.event !== event)
}
