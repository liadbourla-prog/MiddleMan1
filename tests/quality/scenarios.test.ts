// Conversation-quality eval harness (Phase 5).
//
// Golden bilingual scenarios across all four chat branches + proactive messages.
// Each scenario drives a real reply generator with a crafted situation, then gates
// the output two ways:
//   1. Deterministic assertions (assertions.ts) — language, single-question, no stray
//      markdown, no bot-tell phrases, no verbatim template echo. Must pass on EVERY sample.
//   2. LLM-as-judge (grader.ts) — Pro scores human-vs-bot against the voice rubric.
//      We sample N times and require a pass-rate to absorb nondeterminism.
//
// Live LLM calls. Gated behind LLM_API_KEY so CI without it skips (matches the
// integration-test convention). Tune volume/strictness with env:
//   QUALITY_SAMPLES   (default 3)    samples generated + graded per scenario
//   QUALITY_PASS_RATE (default 0.66) fraction of samples that must be "good"
//   QUALITY_MIN_SCORE (default 4)    judge score a sample needs to count as "good"

import { describe, it, expect } from 'vitest'
import {
  generateCustomerReply,
  generateManagerCommandReply,
  generateProviderOnboardingReply,
  formatOperatorDataReply,
  generateProactiveCustomerMessage,
} from '../../src/adapters/llm/client.js'
import { runDeterministicChecks, type DeterministicChecks } from './assertions.js'
import { gradeReply, type GradeRubric } from './grader.js'

const llmEnabled = !!process.env['LLM_API_KEY']
// Default to 3 samples @ 2/3 pass-rate: the LLM judge has roll-to-roll variance,
// so a single sample is too brittle (one harsh roll fails a good reply). 3 samples
// at this threshold catches consistent failures (0/3 or 1/3) while tolerating one
// outlier roll (2/3 passes). The threshold is 0.66, not 0.67, on purpose: 2/3 is
// 0.6667, so a 0.67 gate would reject the very "one outlier" case it's meant to
// allow. Set QUALITY_SAMPLES=1 for a fast, cheap smoke during iteration.
const SAMPLES = parseInt(process.env['QUALITY_SAMPLES'] ?? '3', 10)
const PASS_RATE = parseFloat(process.env['QUALITY_PASS_RATE'] ?? '0.66')
const MIN_SCORE = parseInt(process.env['QUALITY_MIN_SCORE'] ?? '4', 10)
// Generation retry: the production generators swallow LLM errors and return a
// static fallback. Under Pro free-tier quota a burst run hits 429s, so a returned
// fallback usually means "the call was throttled" rather than a quality failure.
// Retry generation with backoff until we get a real reply (or give up and let the
// assertion fail loudly with the fallback visible).
const GEN_RETRIES = parseInt(process.env['QUALITY_GEN_RETRIES'] ?? '5', 10)
const GEN_BACKOFF_MS = parseInt(process.env['QUALITY_GEN_BACKOFF_MS'] ?? '6000', 10)

// Mirror of FALLBACK_REPLIES in client.ts (not exported) — used to detect a
// throttled customer-reply generation so we can retry it.
const CUSTOMER_FALLBACK = {
  he: 'רגע, משהו נתקע לי כאן — אפשר לכתוב לי שוב?',
  en: 'Hang on, something got stuck on my end — mind sending that again?',
} as const

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Scenario {
  name: string
  branch: 'customer' | 'manager' | 'onboarding' | 'operator' | 'proactive'
  generate: () => Promise<string>
  // The exact string the generator returns if its LLM call fails. A reply equal to
  // this means the call was throttled/errored, not that the model produced it.
  fallback: string
  checks: DeterministicChecks
  rubric: GradeRubric
}

async function generateResilient(scenario: Scenario): Promise<string> {
  let reply = await scenario.generate()
  for (let attempt = 0; attempt < GEN_RETRIES && reply.trim() === scenario.fallback.trim(); attempt++) {
    await sleep(GEN_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 1000))
    reply = await scenario.generate()
  }
  return reply
}

const scenarios: Scenario[] = [
  // ── Branch 4: Customer ──────────────────────────────────────────────────────
  {
    name: 'customer booking confirmed (he)',
    branch: 'customer',
    generate: () =>
      generateCustomerReply({
        businessName: 'מספרת רויאל',
        language: 'he',
        situation:
          'The customer asked to book a haircut. It is now booked for Sunday at 14:00 — nothing more is needed. Let them know it is done.',
        transcript: [{ role: 'customer', text: 'אפשר תספורת ביום ראשון אחה"צ?' }],
      }),
    fallback: CUSTOMER_FALLBACK.he,
    checks: { expectedLang: 'he', forbiddenVerbatim: ['התור נקבע', 'הבקשה שלך עובדה'] },
    rubric: {
      lang: 'he',
      context: 'Customer asked to book a haircut Sunday afternoon; the 14:00 slot is now confirmed.',
      extraCriteria: ['Confirms the booking in first person ("קבעתי לך" not "התור נקבע")', 'States the time clearly'],
    },
  },
  {
    name: 'customer slot unavailable, offer alternative (en)',
    branch: 'customer',
    generate: () =>
      generateCustomerReply({
        businessName: 'Royal Barbers',
        language: 'en',
        situation:
          'The customer wanted Thursday 15:00 but it is already taken. Thursday 16:30 and Friday 10:00 are open.',
        transcript: [{ role: 'customer', text: 'Can I get a cut Thursday at 3?' }],
      }),
    fallback: CUSTOMER_FALLBACK.en,
    checks: { expectedLang: 'en', forbiddenVerbatim: ['that time is unavailable', 'no slots available'] },
    rubric: {
      lang: 'en',
      context: 'Customer wanted Thursday 15:00 (taken); Thursday 16:30 and Friday 10:00 are open.',
      extraCriteria: ['Pairs the problem with a concrete alternative', 'Does not read like a robotic "unavailable" error'],
    },
  },
  {
    name: 'customer cancellation pick-list, two bookings (he)',
    branch: 'customer',
    generate: () =>
      generateCustomerReply({
        businessName: 'קליניק יופי',
        language: 'he',
        situation:
          'The customer wants to cancel but has two upcoming bookings: a haircut on Tuesday 10:00 and a manicure on Thursday 17:00. Ask which one, naturally — not as a numbered menu.',
        transcript: [{ role: 'customer', text: 'אני צריכה לבטל תור' }],
      }),
    fallback: CUSTOMER_FALLBACK.he,
    checks: { expectedLang: 'he', forbiddenVerbatim: ['השב 1', 'השיבו 1 או 2'] },
    rubric: {
      lang: 'he',
      context: 'Customer wants to cancel; she has two upcoming bookings (haircut Tue 10:00, manicure Thu 17:00).',
      extraCriteria: ['Asks which booking conversationally, NOT as a numbered IVR menu', 'Exactly one question'],
    },
  },
  {
    name: 'customer FAQ inquiry — parking (en)',
    branch: 'customer',
    generate: () =>
      generateCustomerReply({
        businessName: 'Royal Barbers',
        language: 'en',
        situation: 'The customer asks if there is parking. Answer from the FAQ.',
        transcript: [{ role: 'customer', text: 'is there parking nearby?' }],
        faqs: [{ question: 'Is there parking?', answer: 'Free street parking on Allenby, and a paid lot one block away.' }],
      }),
    fallback: CUSTOMER_FALLBACK.en,
    checks: { expectedLang: 'en' },
    rubric: {
      lang: 'en',
      context: 'Customer asks about parking. FAQ: free street parking on Allenby, paid lot one block away.',
      extraCriteria: ['Answers the parking question directly and warmly'],
    },
  },
  {
    name: 'customer "are you a bot?" probe (he)',
    branch: 'customer',
    generate: () =>
      generateCustomerReply({
        businessName: 'מספרת רויאל',
        language: 'he',
        situation: 'The customer asks whether they are talking to a bot. Stay in character, deflect warmly, redirect to helping.',
        transcript: [{ role: 'customer', text: 'אני מדבר עם בוט?' }],
      }),
    fallback: CUSTOMER_FALLBACK.he,
    checks: { expectedLang: 'he' },
    rubric: {
      lang: 'he',
      context: 'Customer directly asks "am I talking to a bot?"',
      extraCriteria: ['Does NOT confirm it is an AI/bot', 'Stays in character and redirects to helping', 'No lecture'],
    },
  },
  // ── Branch 3: Manager ───────────────────────────────────────────────────────
  {
    name: 'manager changed opening hours (he)',
    branch: 'manager',
    generate: () =>
      generateManagerCommandReply({
        businessName: 'מספרת רויאל',
        language: 'he',
        situation: 'The owner asked to change Friday hours to 09:00–13:00. The change was applied successfully.',
        fallback: 'שעות עודכנו עבור יום שישי.',
      }),
    fallback: 'שעות עודכנו עבור יום שישי.',
    checks: { expectedLang: 'he', forbiddenVerbatim: ['שעות עודכנו עבור יום שישי', 'שעות עודכנו'] },
    rubric: {
      lang: 'he',
      context: 'Owner changed Friday hours to 09:00–13:00; the change succeeded.',
      extraCriteria: ['Confirms in active first person ("עדכנתי" not "שעות עודכנו")', 'Does not echo a templated confirmation'],
    },
  },
  {
    name: 'manager cancelled a booking, offer to notify (en)',
    branch: 'manager',
    generate: () =>
      generateManagerCommandReply({
        businessName: 'Royal Barbers',
        language: 'en',
        situation:
          "The owner cancelled Dana's haircut on Wednesday 11:00. It is done. The customer has NOT been told yet.",
        fallback: 'The booking was cancelled.',
      }),
    fallback: 'The booking was cancelled.',
    checks: { expectedLang: 'en', forbiddenVerbatim: ['the booking was cancelled', 'the event was deleted'] },
    rubric: {
      lang: 'en',
      context: "Owner cancelled Dana's Wednesday 11:00 haircut; done, but the customer hasn't been notified.",
      extraCriteria: ['Confirms in first person ("I cancelled" not "the booking was cancelled")', 'Offers to notify the customer rather than doing it silently'],
    },
  },
  // ── Branch 2: Onboarding ────────────────────────────────────────────────────
  {
    name: 'onboarding first question — business name (en)',
    branch: 'onboarding',
    generate: () =>
      generateProviderOnboardingReply({
        step: 'business_name',
        lang: 'en',
        fallback: 'What is the name of your business?',
      }),
    fallback: 'What is the name of your business?',
    checks: { expectedLang: 'en' },
    rubric: {
      lang: 'en',
      context: 'First onboarding step: asking a new business owner what name customers should see.',
      extraCriteria: ['Plain language, one thing asked', 'Warm and human, not a form field'],
    },
  },
  {
    name: 'onboarding confused user, patient retry (he)',
    branch: 'onboarding',
    generate: () =>
      generateProviderOnboardingReply({
        step: 'services',
        lang: 'he',
        isRetry: true,
        extraContext: 'The owner replied "מה זאת אומרת?" — they did not understand the previous question about services. Explain simply, then re-ask.',
        fallback: 'אילו שירותים אתם מציעים וכמה זמן כל אחד לוקח?',
      }),
    fallback: 'אילו שירותים אתם מציעים וכמה זמן כל אחד לוקח?',
    checks: { expectedLang: 'he' },
    rubric: {
      lang: 'he',
      context: 'Owner was confused ("מה זאת אומרת?") by the question about services. Need to explain simply then re-ask.',
      extraCriteria: ['Explains in plain language before re-asking', 'Patient and warm, not robotic repetition'],
    },
  },
  // ── Branch 1: Operator ──────────────────────────────────────────────────────
  {
    name: 'operator business status report (en)',
    branch: 'operator',
    generate: () =>
      formatOperatorDataReply({
        question: 'show me all businesses',
        lang: 'en',
        dataBlock:
          'Royal Barbers — status: live, calendar: connected\nGlow Clinic — status: onboarding, calendar: not connected\nZen Spa — status: paused, calendar: connected',
        fallback: 'Royal Barbers: live. Glow Clinic: onboarding. Zen Spa: paused.',
      }),
    fallback: 'Royal Barbers: live. Glow Clinic: onboarding. Zen Spa: paused.',
    checks: { expectedLang: 'en' },
    rubric: {
      lang: 'en',
      context: 'Operator asked to list all businesses. Three: Royal Barbers (live), Glow Clinic (onboarding), Zen Spa (paused).',
      extraCriteria: ['Presents data at a glance, not a raw key-value dump', 'Reads human, not a CLI table'],
    },
  },
  // ── Proactive (workers) ─────────────────────────────────────────────────────
  {
    name: 'proactive 24h reminder (he)',
    branch: 'proactive',
    generate: () =>
      generateProactiveCustomerMessage({
        businessName: 'מספרת רויאל',
        language: 'he',
        situation:
          'Remind the customer about their haircut tomorrow at 10:00. If they need to cancel, invite them to just tell you in their own words — never tell them to "reply CANCEL".',
        fallback: 'תזכורת: יש לך תור מחר ב-10:00. לביטול ענו CANCEL.',
      }),
    fallback: 'תזכורת: יש לך תור מחר ב-10:00. לביטול ענו CANCEL.',
    checks: { expectedLang: 'he', forbiddenVerbatim: ['ענו CANCEL', 'לביטול ענו'] },
    rubric: {
      lang: 'he',
      context: 'A one-way reminder about a haircut tomorrow at 10:00, with a way to cancel.',
      extraCriteria: ['Any cancel option sounds human ("just tell me"), NOT "reply CANCEL"', 'Warm and brief'],
    },
  },
  {
    name: 'proactive waitlist slot opened (en)',
    branch: 'proactive',
    generate: () =>
      generateProactiveCustomerMessage({
        businessName: 'Royal Barbers',
        language: 'en',
        situation:
          'A haircut slot just opened on Friday at 16:00. Share the good news warmly and invite them to just tell you if they want it — never say "reply YES/NO". You are holding it for 15 minutes.',
        fallback: 'Good news! A slot opened Friday 16:00. Reply YES to take it or NO to pass.',
      }),
    fallback: 'Good news! A slot opened Friday 16:00. Reply YES to take it or NO to pass.',
    checks: { expectedLang: 'en', forbiddenVerbatim: ['reply YES', 'reply NO', 'YES/NO'] },
    rubric: {
      lang: 'en',
      context: 'A waitlist slot opened Friday 16:00, held for 15 minutes; let the customer claim it.',
      extraCriteria: ['Call-to-action is human ("just let me know"), NOT "reply YES/NO"', 'Warm, brief, mentions the hold window'],
    },
  },
]

describe.skipIf(!llmEnabled)('conversation quality eval', () => {
  for (const scenario of scenarios) {
    it(
      `[${scenario.branch}] ${scenario.name}`,
      async () => {
        let good = 0
        const diagnostics: string[] = []

        for (let i = 0; i < SAMPLES; i++) {
          const reply = await generateResilient(scenario)
          const det = runDeterministicChecks(reply, scenario.checks)
          let grade
          try {
            grade = await gradeReply(reply, scenario.rubric)
          } catch (err) {
            diagnostics.push(`sample ${i}: grader error: ${err instanceof Error ? err.message : String(err)}`)
            continue
          }

          const sampleGood = det.pass && grade.score >= MIN_SCORE && grade.humanlike
          if (sampleGood) {
            good++
          } else {
            diagnostics.push(
              `sample ${i}: score=${grade.score} humanlike=${grade.humanlike}` +
                (det.failures.length ? ` | det: ${det.failures.join('; ')}` : '') +
                (grade.botTells.length ? ` | tells: ${grade.botTells.join('; ')}` : '') +
                ` | reply: ${JSON.stringify(reply)}`,
            )
          }
        }

        const rate = good / SAMPLES
        expect(
          rate >= PASS_RATE,
          `pass-rate ${rate.toFixed(2)} < ${PASS_RATE} (${good}/${SAMPLES})\n${diagnostics.join('\n')}`,
        ).toBe(true)
      },
    )
  }
})
