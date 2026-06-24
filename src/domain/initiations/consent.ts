// Two-tier consent decision (Phase 5.1; design §7) — pure. messagingOptOut is the GLOBAL
// kill-switch (suppresses everything). promotionalOptOuts is the per-category map: `all: true`
// stops all promotional sends; `{category}: true` stops that category. Transactional sends never
// call this (the gate bypasses opt-out for them); it governs only promotional customer/contact sends.

export type PromotionalOptOuts = Record<string, boolean>

/**
 * Whether a PROMOTIONAL send is suppressed for this recipient. True when globally opted out,
 * when all promotional is opted out, or when this category is opted out.
 */
export function isPromotionalSuppressed(
  messagingOptOut: boolean,
  promotionalOptOuts: PromotionalOptOuts | null | undefined,
  category: string | undefined,
): boolean {
  if (messagingOptOut) return true
  if (!promotionalOptOuts) return false
  if (promotionalOptOuts['all'] === true) return true
  if (category !== undefined && promotionalOptOuts[category] === true) return true
  return false
}
