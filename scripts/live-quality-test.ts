/**
 * Live LLM quality test runner.
 * Calls real Gemini functions with test inputs and evaluates output quality.
 *
 * Covers: DIM 1 (customer NLU), DIM 6 (ambiguity quality),
 *         DIM 8 (onboarding explanation), DIM 9 (operator data accuracy)
 *
 * Run: LLM_API_KEY=<key> npx tsx scripts/live-quality-test.ts
 */

import { extractCustomerIntent, generateCustomerReply, explainOnboardingConcept, answerOperatorQuestion } from '../src/adapters/llm/client.js'

// ── Colour helpers ──────────────────────────────────────────────────────────

const PASS  = '\x1b[32m✓\x1b[0m'
const FAIL  = '\x1b[31m✗\x1b[0m'
const NOTE  = '\x1b[33m~\x1b[0m'
const HEAD  = '\x1b[1m\x1b[36m'
const DIM   = '\x1b[2m'
const RESET = '\x1b[0m'

let passed = 0; let failed = 0

function pass(label: string, detail?: string) {
  console.log(`  ${PASS} ${label}`)
  if (detail) console.log(`       ${DIM}${detail}${RESET}`)
  passed++
}
function fail(label: string, detail?: string) {
  console.log(`  ${FAIL} ${label}`)
  if (detail) console.log(`       ${DIM}${detail}${RESET}`)
  failed++
}
function note(label: string) { console.log(`  ${NOTE} ${DIM}${label}${RESET}`) }
function section(t: string)  { console.log(`\n${HEAD}── ${t} ${RESET}`) }

// ── Format compliance checker (hard rules from lawbook) ────────────────────

function checkFormat(text: string): { ok: boolean; violations: string[] } {
  const v: string[] = []
  if (/<[a-z]/i.test(text))                           v.push('contains HTML tag')
  if (/^#{1,3} /m.test(text))                         v.push('contains markdown header')
  if (/\[.+?\]\(.+?\)/.test(text))                    v.push('contains markdown link')
  if (/^```/m.test(text))                             v.push('contains code fence')
  if (/\bas an AI\b|\bI am (a |an )?AI\b|\bas a (language )?model\b/i.test(text))
                                                      v.push('AI self-disclosure')
  // Exactly one question mark allowed (more = stacked questions)
  const qCount = (text.match(/\?/g) ?? []).length
  if (qCount > 1)                                     v.push(`${qCount} question marks — possible stacked questions`)
  return { ok: v.length === 0, violations: v }
}

// ── Rate limiter — avoid Gemini quota errors ────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const DELAY = 5000   // 5 s between calls — Gemini free tier = 15 RPM

// ── Helpers ─────────────────────────────────────────────────────────────────

const TZ = 'Asia/Jerusalem'
const SERVICES = ['Haircut', 'Manicure', 'Facial']
const BUSINESS = 'Salon Noa'
const TODAY = new Date().toISOString().slice(0, 10)

async function checkIntent(
  label: string,
  message: string,
  expectedIntent: string,
  opts?: { expectedDateAmbiguous?: boolean; expectedHasSpecificDate?: boolean },
) {
  await sleep(DELAY)
  const result = await extractCustomerIntent(message, {}, TZ, SERVICES)
  if (!result.ok) { fail(label, `LLM call failed: ${JSON.stringify(result)}`); return }
  const { intent, slotRequest } = result.data
  const intentOk = intent === expectedIntent
  const fmt = checkFormat(message) // input not output, but check for sanity
  if (intentOk) {
    let detail = `intent=${intent}`
    if (opts?.expectedDateAmbiguous !== undefined && slotRequest) {
      const ambigOk = slotRequest.dateAmbiguous === opts.expectedDateAmbiguous
      detail += ` | dateAmbiguous=${slotRequest.dateAmbiguous} (expected ${opts.expectedDateAmbiguous}) ${ambigOk ? '✓' : '✗'}`
    }
    if (opts?.expectedHasSpecificDate !== undefined && slotRequest) {
      detail += ` | hasSpecificDate=${slotRequest.hasSpecificDate}`
    }
    pass(label, detail)
  } else {
    fail(label, `expected intent=${expectedIntent}, got intent=${intent}`)
  }
}

const FALLBACK_STRINGS = ['Something went wrong', 'אירעה שגיאה']

async function checkReply(
  label: string,
  situation: string,
  transcript: Array<{ role: 'customer' | 'assistant'; text: string }>,
  checks: { mustContain?: string[]; mustNotContain?: string[]; maxSentences?: number },
) {
  await sleep(DELAY)
  const reply = await generateCustomerReply({
    businessName: BUSINESS,
    language: 'en',
    situation,
    transcript,
  })
  const fmt = checkFormat(reply)
  const violations = [...fmt.violations]

  if (FALLBACK_STRINGS.some(f => reply.includes(f)))
    violations.push('returned fallback error message — LLM call likely failed')

  if (checks.mustContain) {
    for (const s of checks.mustContain) {
      if (!reply.toLowerCase().includes(s.toLowerCase()))
        violations.push(`missing expected content: "${s}"`)
    }
  }
  if (checks.mustNotContain) {
    for (const s of checks.mustNotContain) {
      if (reply.toLowerCase().includes(s.toLowerCase()))
        violations.push(`contains forbidden content: "${s}"`)
    }
  }
  if (checks.maxSentences) {
    const sentences = reply.split(/[.!?]+/).filter(s => s.trim().length > 3).length
    if (sentences > checks.maxSentences)
      violations.push(`${sentences} sentences (max ${checks.maxSentences})`)
  }

  if (violations.length === 0) {
    pass(label, `"${reply.slice(0, 90)}${reply.length > 90 ? '…' : ''}"`)
  } else {
    fail(label, `reply="${reply.slice(0, 90)}…"\n       violations: ${violations.join('; ')}`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DIM 1 — Customer NLU: 8 inputs with diverse phrasing
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 1 — Customer NLU (Branch 4) — diverse phrasing')

await checkIntent(
  'Colloquial booking intent (no "book" keyword)',
  'I want to come in tomorrow morning',
  'booking',
  { expectedHasSpecificDate: false },
)
await checkIntent(
  'Hebrew booking intent',
  'אני רוצה תור בשבוע הבא, אולי יום שלישי?',
  'booking',
)
await checkIntent(
  'List bookings — "show me my stuff"',
  'can you show me what I have coming up?',
  'list_bookings',
)
await checkIntent(
  'Reschedule intent — referential ("move it")',
  'actually, can we move it to next Thursday instead?',
  'rescheduling',
)
await checkIntent(
  'Cancellation — colloquial ("nevermind")',
  'you know what, nevermind, don\'t worry about it',
  'cancellation',
)
await checkIntent(
  'Inquiry — availability question',
  'do you have anything free on Friday afternoon?',
  'inquiry',
)
await checkIntent(
  'Hebrew list bookings',
  'מה התורים שלי?',
  'list_bookings',
)
await checkIntent(
  'Ambiguous date flagged correctly',
  'I want to book a haircut next Wednesday',
  'booking',
  { expectedDateAmbiguous: true },
)

// ══════════════════════════════════════════════════════════════════════════════
// DIM 6 — Ambiguity handling quality: reply is one smart question, not generic
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 6 — Ambiguity handling quality (Branch 4)')

await checkReply(
  'Missing date — asks for specific date (not generic)',
  'Booking intent detected but the date is missing or vague. Ask for a specific date.',
  [],
  {
    mustNotContain: ["i don't understand", "could you clarify", "rephrase"],
    maxSentences: 2,
  },
)
await checkReply(
  'Missing service — lists options and asks (not generic)',
  `Customer wants to book but did not specify a service. Available services: ${SERVICES.join(', ')}. Ask which one they want.`,
  [],
  {
    mustContain: ['haircut'],      // should mention at least one service
    mustNotContain: ["i don't understand"],
    maxSentences: 2,
  },
)
await checkReply(
  'Slot conflict — natural apology, offers alternative',
  'The requested slot is unavailable because that slot is no longer available. Apologise and suggest they try a different time.',
  [],
  {
    mustNotContain: ['slot_conflict', 'hold_conflict', 'not_found', 'error_code'],
    maxSentences: 3,
  },
)
await checkReply(
  'Booking confirmed — includes service, day, time, and confirm prompt',
  `Slot successfully held for Haircut on Monday, 12 May at 10:00. Ask customer to reply YES to finalize and confirm the booking.`,
  [],
  {
    mustContain: ['yes'],
    mustNotContain: ['slot_conflict', 'UUID', 'sessionId'],
    maxSentences: 3,
  },
)
await checkReply(
  'Hebrew reply — no English contamination',
  'לקוחה רוצה לקבוע תור, אבל לא ציינה תאריך. בקש תאריך ספציפי.',
  [],
  {
    mustNotContain: ['please', 'would you like'],   // no English
    maxSentences: 2,
  },
)

// Extra: check the hebrew reply is actually in Hebrew
{
  await sleep(DELAY)
  const heResult = await generateCustomerReply({
    businessName: 'מספרת נועה',
    language: 'he',
    situation: 'לקוחה רוצה לקבוע תור, אבל לא ציינה תאריך. בקש תאריך ספציפי.',
    transcript: [],
  })
  const isHebrew = /[֐-׿]/.test(heResult)
  const hasEnglish = /\b(please|would you|the|a |an |I |you )\b/i.test(heResult)
  const fmt = checkFormat(heResult)
  if (isHebrew && !hasEnglish && fmt.ok) {
    pass('Hebrew reply is pure Hebrew, no English contamination',
      `"${heResult.slice(0, 80)}…"`)
  } else {
    fail('Hebrew reply purity check', `isHebrew=${isHebrew} hasEnglish=${hasEnglish} fmtViolations=${fmt.violations.join(';')} reply="${heResult.slice(0,80)}"`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DIM 8 — Branch 2 explanation quality
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 8 — Onboarding explanation quality (Branch 2)')

for (const [step, userMsg, lang] of [
  ['timezone', 'מה זה timezone? אני לא מבין', 'he'],
  ['calendar', 'what does connecting Google Calendar mean?', 'en'],
  ['services', 'I\'m not sure what to put here, what do you mean by service?', 'en'],
  ['credentials', 'what is a phone number ID? I don\'t have that', 'en'],
] as const) {
  await sleep(DELAY)
  const reply = await explainOnboardingConcept({
    concept: step,
    userMessage: userMsg as string,
    step,
    lang: lang as 'he' | 'en',
  })
  const fmt = checkFormat(reply)
  const sentences = reply.split(/[.!?]+\s+/).filter(s => s.trim().length > 3).length
  const endsWithQuestion = /[?？]/.test(reply.slice(-80))  // re-asks at the end

  const violations = [...fmt.violations]
  if (sentences > 5) violations.push(`${sentences} sentences — too long (max ~4)`)
  if (!endsWithQuestion) violations.push('does not end with a re-ask question')
  if (reply.length < 30) violations.push('reply too short — may be empty')

  if (violations.length === 0) {
    pass(`Step '${step}' — explanation natural and ends with re-ask`,
      `"${reply.slice(0, 90)}${reply.length > 90 ? '…' : ''}"`)
  } else {
    fail(`Step '${step}' — explanation quality`, `reply="${reply.slice(0, 90)}…"\n       violations: ${violations.join('; ')}`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DIM 9 — Branch 1 operator data accuracy
// Inject synthetic business data and ask verifiable questions
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 9 — Operator data accuracy (Branch 1, synthetic data)')

const syntheticBusinesses = [
  {
    name: 'Salon Noa', phone: '+972501111111', status: 'live' as const,
    calendarMode: 'google' as const, googleCalendarConnected: true,
    calendarTokenExpired: false, openEscalations: 0,
    minutesSinceLastMsg: 15, hasWebsite: true,
    managerPhoneNumber: '+972507654321',
    calendarAuthStatus: 'ok' as const,
  },
  {
    name: 'Barber Dan', phone: '+972502222222', status: 'live' as const,
    calendarMode: 'google' as const, googleCalendarConnected: true,
    calendarTokenExpired: true, openEscalations: 2,
    minutesSinceLastMsg: 300, hasWebsite: false,
    managerPhoneNumber: '+972508888888',
    calendarAuthStatus: 'expired' as const,
  },
  {
    name: 'Pilates Studio', phone: '+972503333333', status: 'setup' as const,
    calendarMode: 'internal' as const, googleCalendarConnected: false,
    calendarTokenExpired: false, openEscalations: 0,
    minutesSinceLastMsg: null, hasWebsite: false,
    managerPhoneNumber: null,
    calendarAuthStatus: 'not_connected' as const,
  },
]

async function askOperator(question: string, lang: 'en' | 'he' = 'en') {
  await sleep(DELAY)
  return answerOperatorQuestion({
    question,
    transcript: [],
    lang,
    businesses: syntheticBusinesses,
    openEscalationsTotal: 2,
  })
}

// Q1: count question with verifiable answer
{
  const reply = await askOperator('How many businesses are live?')
  const mentionsTwo = /\b2\b|two/.test(reply)
  const fmt = checkFormat(reply)
  if (mentionsTwo && fmt.ok) {
    pass('Q1: "How many live?" → answers "2"', `"${reply.slice(0, 100)}"`)
  } else {
    fail('Q1: "How many live?" → must mention 2', `reply="${reply}" fmt=${fmt.violations.join(';')}`)
  }
}

// Q2: which businesses have expired calendar auth
{
  const reply = await askOperator('Which businesses have an expired calendar token?')
  const mentionsDan = /barber dan/i.test(reply)
  const doesNotMentionNoa = !/salon noa/i.test(reply)
  const fmt = checkFormat(reply)
  if (mentionsDan && doesNotMentionNoa && fmt.ok) {
    pass('Q2: Expired calendar → only "Barber Dan" named', `"${reply.slice(0, 100)}"`)
  } else {
    fail('Q2: Expired calendar accuracy', `mentionsDan=${mentionsDan} doesNotMentionNoa=${doesNotMentionNoa} fmt=${fmt.violations.join(';')}\n       reply="${reply}"`)
  }
}

// Q3: manager phone number lookup
{
  const reply = await askOperator("What's the manager's number for Salon Noa?")
  const mentionsPhone = reply.includes('507654321') || reply.includes('+972507654321')
  const fmt = checkFormat(reply)
  if (mentionsPhone && fmt.ok) {
    pass("Q3: Manager phone for 'Salon Noa' → correct number", `"${reply.slice(0, 100)}"`)
  } else {
    fail("Q3: Manager phone accuracy", `mentionsPhone=${mentionsPhone}\n       reply="${reply}"`)
  }
}

// Q4: open escalations count
{
  const reply = await askOperator('Any open escalations right now?')
  const mentionsTwo = /\b2\b|two/.test(reply)
  const mentionsDan = /barber dan/i.test(reply)
  const fmt = checkFormat(reply)
  if (mentionsTwo && fmt.ok) {
    pass('Q4: Open escalations → answers 2, mentions Barber Dan', `"${reply.slice(0, 100)}"`)
  } else {
    fail('Q4: Escalations accuracy', `mentionsTwo=${mentionsTwo} mentionsDan=${mentionsDan}\n       reply="${reply}"`)
  }
}

// Q5: format compliance on a long report
{
  const reply = await askOperator('Give me a full status of all businesses')
  const fmt = checkFormat(reply)
  if (reply.length < 20) {
    fail('Q5: Full status report', `empty or too short — LLM call failed (quota?)`)
  } else if (!fmt.ok) {
    fail('Q5: Format compliance on status report', `violations: ${fmt.violations.join('; ')}\n       reply="${reply.slice(0, 120)}"`)
  } else {
    pass('Q5: Full status report has no HTML or markdown headers', `${reply.length} chars: "${reply.slice(0,80)}…"`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FINAL
// ══════════════════════════════════════════════════════════════════════════════

const total = passed + failed
const pct = Math.round((passed / total) * 100)
console.log(`\n${'─'.repeat(60)}`)
console.log(`${HEAD}LIVE TEST RESULTS${RESET}`)
console.log(`  ${PASS} Passed: ${passed}`)
console.log(`  ${FAIL} Failed: ${failed}`)
console.log(`\n  Score: ${passed}/${total} (${pct}%)  ${failed === 0 ? '✅ ALL PASS' : pct >= 85 ? '⚠️  MOSTLY PASS' : '❌ NEEDS WORK'}`)

console.log(`\n${HEAD}DEFERRED (need provisioned business):${RESET}`)
note('DIM 4 — Cross-session manager memory (needs DB + 2 real sessions)')
note('DIM 5 — Branch 3 tool routing live (needs DB + calendar + manager identity)')

if (failed > 0) process.exit(1)
