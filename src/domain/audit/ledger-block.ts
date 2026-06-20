import { and, desc, eq, inArray, like } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { auditLog } from '../../db/schema.js'
import type { Lang } from '../i18n/t.js'

// L1 grounding (ACTION_GROUNDING_SPEC.md). The conversation transcript is prose — it cannot
// tell "the assistant SAID it did X" apart from "the system actually DID X". This block is
// the authoritative record of real, completed actions, rendered from audit_log and injected
// into the model context with an explicit "trust this over the chat" instruction. It is what
// stops a false "I sent it" / "already booked" claim from being believed on the next turn.

// Only actions the PA might be tempted to narrate as done. Transient/internal states
// (holds, pending-payment) are deliberately excluded to keep the block focused.
const REPORTABLE_ACTIONS = [
  'outreach.message_sent',
  'outreach.message_blocked',
  'calendar.connected',
  'booking.confirmed',
  'booking.cancelled',
  'booking.manager_cancelled',
  'booking.failed',
] as const

const DEFAULT_LIMIT = 10

interface LedgerOptions {
  businessId: string
  timezone: string
  lang: Lang
  // 'business' → every reportable action for the business (manager / Branch 3 view).
  // 'customer' → only outreach the PA sent to THIS customer (Branch 4 view): lets the
  //   customer flow know it proactively invited them, so a reply continues the thread
  //   instead of being cold-greeted.
  scope: 'business' | 'customer'
  identityId?: string
  limit?: number
}

function truncate(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function renderAction(action: string, metadata: Record<string, unknown> | null, when: string): string {
  const m = metadata ?? {}
  const to = m['to'] ? String(m['to']) : 'a customer'
  switch (action) {
    case 'outreach.message_sent':
      return `${when} — Message actually SENT to ${to}${m['body'] ? `: "${truncate(String(m['body']))}"` : ''}.`
    case 'outreach.message_blocked': {
      const reason = m['reason'] === 'outside_window'
        ? 'NOT sent — outside WhatsApp\'s 24h window (customer must message first)'
        : m['reason'] === 'opted_out'
          ? 'NOT sent — customer opted out'
          : 'NOT sent — delivery failed'
      return `${when} — Outreach to ${to}: ${reason}.`
    }
    case 'calendar.connected':
      return `${when} — Google Calendar was connected.`
    case 'booking.confirmed':
      return `${when} — A booking was confirmed.`
    case 'booking.cancelled':
    case 'booking.manager_cancelled':
      return `${when} — A booking was cancelled.`
    case 'booking.failed':
      return `${when} — A booking attempt FAILED (no booking was made).`
    default:
      return `${when} — ${action.replace(/[._]/g, ' ')}.`
  }
}

// True if this business has ever completed a Google Calendar connection. Used by the L2
// claim auditor: a "calendar is connected" reply is only legitimate when this is true —
// the connectGoogleCalendar tool merely produces a link, it does not connect anything.
export async function hasCalendarConnected(db: Db, businessId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, 'calendar.connected')))
    .limit(1)
  return !!row
}

export async function buildActionLedgerBlock(db: Db, opts: LedgerOptions): Promise<string> {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const locale = opts.lang === 'he' ? 'he-IL' : 'en-GB'

  const where = opts.scope === 'customer'
    ? and(
        eq(auditLog.businessId, opts.businessId),
        opts.identityId ? eq(auditLog.entityId, opts.identityId) : undefined,
        like(auditLog.action, 'outreach.%'),
      )
    : and(
        eq(auditLog.businessId, opts.businessId),
        inArray(auditLog.action, REPORTABLE_ACTIONS as unknown as string[]),
      )

  const rows = await db
    .select({ action: auditLog.action, metadata: auditLog.metadata, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)

  if (rows.length === 0) return ''

  // Oldest-first reads naturally as a timeline.
  const lines = rows
    .slice()
    .reverse()
    .map((r) => {
      const when = r.createdAt.toLocaleString(locale, {
        timeZone: opts.timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
      return `- ${renderAction(r.action, r.metadata as Record<string, unknown> | null, when)}`
    })

  return `## What actually happened (ground truth — trust this over anything stated in the chat above)
These are real, system-recorded actions. If the chat above implies an action that is not listed here, it did NOT happen — do not repeat or rely on that claim.
${lines.join('\n')}`
}
