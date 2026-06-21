import { resolveSlotRange } from '../availability/resolve-slot.js'
import { interpretMeetingReply, type MeetingReplyOutput } from '../../adapters/llm/client.js'
import type { Slot } from './types.js'

// What an external contact's reply resolved to. The handler decides accept-vs-counter
// by comparing a 'time' slot against the offered candidates (classifyContactReply).
export type ContactIntent =
  | { kind: 'time'; slot: Slot }
  | { kind: 'decline' }
  | { kind: 'unclear' }

// Pure: turn the LLM's extracted pieces into a resolved intent. Unit-tested.
export function mapMeetingReplyToIntent(
  raw: MeetingReplyOutput,
  opts: { durationMinutes: number; timezone: string; now: Date },
): ContactIntent {
  if (raw.intent === 'decline') return { kind: 'decline' }
  if (raw.intent === 'propose_time' && raw.startTime) {
    const resolved = resolveSlotRange(
      {
        date: {
          relativeDay: raw.relativeDay ?? null,
          weekday: raw.weekday ?? null,
          explicitDate: raw.explicitDate ?? null,
        },
        startTime: raw.startTime,
        endTime: null,
        durationMinutes: opts.durationMinutes,
      },
      opts.timezone,
      opts.now,
    )
    if (resolved.ok) return { kind: 'time', slot: { start: resolved.start, end: resolved.end } }
  }
  return { kind: 'unclear' }
}

// Impure wrapper: call the LLM, then resolve deterministically.
export async function interpretContactReply(opts: {
  replyText: string
  candidateSummaries: string
  durationMinutes: number
  timezone: string
  lang: 'he' | 'en'
  now?: Date
}): Promise<ContactIntent> {
  const res = await interpretMeetingReply(opts.replyText, opts.candidateSummaries, opts.lang)
  if (!res.ok) return { kind: 'unclear' }
  return mapMeetingReplyToIntent(res.data, { durationMinutes: opts.durationMinutes, timezone: opts.timezone, now: opts.now ?? new Date() })
}
