// The Eligibility Gate — one pure, deterministic decision every proactive outbound
// passes before it can leave. No I/O, no clock, no timezone math: all of that is
// gathered by the dispatcher and passed in as GateInput. Mirrors the pure-core
// discipline of src/domain/coordination/state.ts (returns a decision; caller executes).
//
// Dedup is intentionally NOT decided here — it is inherently stateful and is enforced
// race-safely by the unique (business_id, dedup_key) index in dispatch.ts.

import type { GateInput, GateDecision } from './types.js'

export function runGate(input: GateInput): GateDecision {
  if (!input.enabled) return { kind: 'skip', reason: 'disabled' }

  // Owner/operator sends are operational alerts to the business itself, not to an
  // outside party. They are never gated by the 24h window or consent — preserving the
  // current escalation behavior (unconditional notify).
  if (input.audience === 'owner' || input.audience === 'operator') {
    return { kind: 'send_free_form' }
  }

  // Promotional customer/contact sends respect opt-out and quiet hours.
  // Transactional ones (reminders, etc.) skip straight to window resolution.
  if (input.consentClass === 'promotional') {
    if (input.recipientOptedOut) return { kind: 'skip', reason: 'opted_out' }
    if (input.nowInQuietHours) return { kind: 'skip', reason: 'quiet_hours' }
  }

  // 24h-window resolution for customer/contact audiences.
  if (input.windowOpen) return { kind: 'send_free_form' }
  if (input.windowPolicy !== 'skip') {
    return { kind: 'send_template', templateName: input.windowPolicy.templateName }
  }
  return { kind: 'skip', reason: 'outside_window_no_template' }
}
