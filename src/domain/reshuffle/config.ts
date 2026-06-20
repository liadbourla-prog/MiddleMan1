// Proactive Reshuffle Engine — owner-configurable knobs + protected-party logic.
//
// All elastic per the product owner (decisions A4/X2/D3): batch size, approval gate,
// protect window, etc. A `null`/partial config resolves to safe defaults via the single
// `resolveReshuffleConfig` reader (one-reader-per-fact discipline). Pure, no I/O.

export type ApprovalMode = 'require_approval' | 'auto_apply'
export type EscalationRung = 'direct' | 'chain' | 'broadcast'
export type ContactScope = 'conflicting_only' | 'service_match' | 'all_booked'

export interface QuietHours {
  /** 'HH:MM' local to the business timezone. */
  start: string
  end: string
}

export interface ReshuffleConfig {
  enabled: boolean
  approvalMode: ApprovalMode
  /** Customers contacted per broadcast wave. 0 = no cap. */
  batchSize: number
  escalationLadder: EscalationRung[]
  maxChainLength: number
  offerTtlMinutes: number
  maxOutreachPerCampaign: number
  quietHours: QuietHours | null
  contactScope: ContactScope
  respectMessagingOptOut: boolean
  protectWindowHours: number
  protectVip: boolean
  protectRecentlyRescheduled: boolean
  recentRescheduleLookbackHours: number
  offerBetterSlotToRequester: boolean
  allowOwnerTweak: boolean
}

export const DEFAULT_RESHUFFLE_CONFIG: ReshuffleConfig = {
  enabled: false,
  approvalMode: 'require_approval',
  batchSize: 7,
  escalationLadder: ['direct', 'chain', 'broadcast'],
  maxChainLength: 3,
  offerTtlMinutes: 30,
  maxOutreachPerCampaign: 21,
  quietHours: { start: '21:00', end: '08:00' },
  contactScope: 'service_match',
  respectMessagingOptOut: true,
  protectWindowHours: 3,
  protectVip: true,
  protectRecentlyRescheduled: true,
  recentRescheduleLookbackHours: 168,
  offerBetterSlotToRequester: true,
  allowOwnerTweak: true,
}

const APPROVAL_MODES: ApprovalMode[] = ['require_approval', 'auto_apply']
const RUNGS: EscalationRung[] = ['direct', 'chain', 'broadcast']
const SCOPES: ContactScope[] = ['conflicting_only', 'service_match', 'all_booked']

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** A non-negative integer, falling back to `dflt` when the input is absent/invalid. */
function nonNegInt(v: unknown, dflt: number): number {
  if (v === null || v === undefined || typeof v !== 'number' || !Number.isFinite(v)) return dflt
  return Math.max(0, Math.floor(v))
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}

function fromEnum<T extends string>(v: unknown, allowed: T[], dflt: T): T {
  return typeof v === 'string' && (allowed as string[]).includes(v) ? (v as T) : dflt
}

function resolveQuietHours(v: unknown): QuietHours | null {
  if (v === null) return null
  if (v === undefined) return DEFAULT_RESHUFFLE_CONFIG.quietHours
  if (isRecord(v) && typeof v['start'] === 'string' && typeof v['end'] === 'string') {
    return { start: v['start'], end: v['end'] }
  }
  return DEFAULT_RESHUFFLE_CONFIG.quietHours
}

/**
 * Merge an owner-supplied (possibly partial / null / malformed) config over the defaults,
 * clamping nonsensical values rather than throwing. The persisted column is untrusted input.
 */
export function resolveReshuffleConfig(raw: unknown): ReshuffleConfig {
  if (!isRecord(raw)) return { ...DEFAULT_RESHUFFLE_CONFIG }
  const d = DEFAULT_RESHUFFLE_CONFIG

  const ladder = Array.isArray(raw['escalationLadder'])
    ? (raw['escalationLadder'].filter((r): r is EscalationRung => RUNGS.includes(r as EscalationRung)))
    : d.escalationLadder
  // 'batchSize: 0 / null' explicitly means "no cap".
  const rawBatch = raw['batchSize']
  const batchSize = rawBatch === null ? 0 : nonNegInt(rawBatch, d.batchSize)

  return {
    enabled: bool(raw['enabled'], d.enabled),
    approvalMode: fromEnum(raw['approvalMode'], APPROVAL_MODES, d.approvalMode),
    batchSize,
    escalationLadder: ladder.length > 0 ? ladder : d.escalationLadder,
    maxChainLength: Math.max(2, nonNegInt(raw['maxChainLength'], d.maxChainLength)),
    offerTtlMinutes: Math.max(1, nonNegInt(raw['offerTtlMinutes'], d.offerTtlMinutes)),
    maxOutreachPerCampaign: nonNegInt(raw['maxOutreachPerCampaign'], d.maxOutreachPerCampaign),
    quietHours: resolveQuietHours(raw['quietHours']),
    contactScope: fromEnum(raw['contactScope'], SCOPES, d.contactScope),
    respectMessagingOptOut: bool(raw['respectMessagingOptOut'], d.respectMessagingOptOut),
    protectWindowHours: nonNegInt(raw['protectWindowHours'], d.protectWindowHours),
    protectVip: bool(raw['protectVip'], d.protectVip),
    protectRecentlyRescheduled: bool(raw['protectRecentlyRescheduled'], d.protectRecentlyRescheduled),
    recentRescheduleLookbackHours: nonNegInt(raw['recentRescheduleLookbackHours'], d.recentRescheduleLookbackHours),
    offerBetterSlotToRequester: bool(raw['offerBetterSlotToRequester'], d.offerBetterSlotToRequester),
    allowOwnerTweak: bool(raw['allowOwnerTweak'], d.allowOwnerTweak),
  }
}

export interface ProtectionInput {
  slotStart: Date
  vip: boolean
  /** When this booking was last moved, or null if never. */
  lastRescheduledAt: Date | null
}

const HOUR_MS = 3_600_000

/**
 * Whether a booking may NOT be moved to accommodate someone else (decision A4).
 * Near-term (incl. already-started), VIP, or recently-rescheduled bookings are shielded.
 * A protected booking may still initiate its own request — this only blocks involuntary moves.
 */
export function isProtectedFromMove(input: ProtectionInput, config: ReshuffleConfig, now: Date): boolean {
  const hoursUntilStart = (input.slotStart.getTime() - now.getTime()) / HOUR_MS
  if (hoursUntilStart < config.protectWindowHours) return true

  if (config.protectVip && input.vip) return true

  if (config.protectRecentlyRescheduled && input.lastRescheduledAt) {
    const hoursSinceMove = (now.getTime() - input.lastRescheduledAt.getTime()) / HOUR_MS
    if (hoursSinceMove < config.recentRescheduleLookbackHours) return true
  }

  return false
}
