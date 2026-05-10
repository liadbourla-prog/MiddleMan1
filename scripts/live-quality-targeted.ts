/**
 * Targeted live quality test — covers only items inconclusive from prior runs.
 * Includes 90s initial cooldown + 8s between calls to stay within 10 RPM quota.
 * Run: LLM_API_KEY=<key> npx tsx scripts/live-quality-targeted.ts
 */

import { generateCustomerReply, explainOnboardingConcept, answerOperatorQuestion, extractCustomerIntent } from '../src/adapters/llm/client.js'

const PASS = '\x1b[32m✓\x1b[0m'; const FAIL = '\x1b[31m✗\x1b[0m'
const HEAD = '\x1b[1m\x1b[36m'; const DIM = '\x1b[2m'; const RESET = '\x1b[0m'
let passed = 0; let failed = 0

function pass(l: string, d?: string) { console.log(`  ${PASS} ${l}${d ? `\n       ${DIM}${d}${RESET}` : ''}`); passed++ }
function fail(l: string, d?: string) { console.log(`  ${FAIL} ${l}${d ? `\n       ${DIM}${d}${RESET}` : ''}`); failed++ }
function section(t: string) { console.log(`\n${HEAD}── ${t} ${RESET}`) }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const DELAY = 8000
const FALLBACKS = ['Something went wrong', 'אירעה שגיאה']

function fmtCheck(text: string) {
  const v: string[] = []
  if (/<[a-z]/i.test(text)) v.push('HTML tag')
  if (/^#{1,3} /m.test(text)) v.push('markdown header')
  if (/\[.+?\]\(.+?\)/.test(text)) v.push('markdown link')
  if (/\bas an AI\b|\bI am (a |an )?AI\b/i.test(text)) v.push('AI disclosure')
  if (FALLBACKS.some(f => text.includes(f))) v.push('fallback error string')
  if (text.length < 10) v.push('too short / empty')
  return v
}

// ── Cooldown ─────────────────────────────────────────────────────────────────

console.log('Waiting 90s for Gemini quota cooldown…')
for (let i = 90; i > 0; i -= 10) { process.stdout.write(`\r  ${i}s remaining…  `); await sleep(10000) }
console.log('\r  Ready.                        ')

// ══════════════════════════════════════════════════════════════════════════════
// DIM 1 — The one genuine failure: "nevermind" → should be cancellation
// Test with context (as it always appears in real conversations)
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 1 — Cancellation (with session context)')

await sleep(DELAY)
const nevermindResult = await extractCustomerIntent(
  "you know what, nevermind",
  { state: 'waiting_confirmation', pendingService: 'Haircut', pendingDate: '2026-05-15' },
  'Asia/Jerusalem',
  ['Haircut', 'Manicure'],
)
if (!nevermindResult.ok) {
  fail('"nevermind" with context → cancellation', `LLM error: ${nevermindResult.error}`)
} else {
  const ok = nevermindResult.data.intent === 'cancellation' || nevermindResult.data.intent === 'unknown'
  if (nevermindResult.data.intent === 'cancellation') {
    pass('"nevermind" with session context → cancellation ✓', `intent=${nevermindResult.data.intent}`)
  } else {
    fail('"nevermind" with session context still → unknown (note: deterministic flow overrides this)',
      `intent=${nevermindResult.data.intent} — acceptable because the booking flow handles "NO" replies directly without LLM`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DIM 6 — generateCustomerReply quality checks (3 scenarios)
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 6 — Reply quality (Branch 4)')

await sleep(DELAY)
const serviceReply = await generateCustomerReply({
  businessName: 'Salon Noa', language: 'en',
  situation: 'Customer wants to book but did not specify a service. Available services: Haircut, Manicure, Facial. Ask which one they want.',
  transcript: [],
})
{
  const v = fmtCheck(serviceReply)
  const mentionsService = /haircut|manicure|facial/i.test(serviceReply)
  const qCount = (serviceReply.match(/\?/g) ?? []).length
  if (qCount > 1) v.push(`${qCount} question marks — stacked questions`)
  if (!mentionsService) v.push('does not mention any service')
  if (v.length === 0) pass('Missing service → lists options + one question', `"${serviceReply}"`)
  else fail('Missing service reply', `violations: ${v.join('; ')}\n       reply: "${serviceReply}"`)
}

await sleep(DELAY)
const confirmReply = await generateCustomerReply({
  businessName: 'Salon Noa', language: 'en',
  situation: 'Slot successfully held for Haircut on Monday, 12 May at 10:00. Ask customer to reply YES to finalize and confirm the booking.',
  transcript: [],
})
{
  const v = fmtCheck(confirmReply)
  const hasYes = /yes/i.test(confirmReply)
  const hasService = /haircut/i.test(confirmReply)
  const hasTime = /10[:\.]00|10 am/i.test(confirmReply)
  if (!hasYes) v.push('missing YES prompt')
  if (!hasService) v.push('missing service name')
  if (!hasTime) v.push('missing time')
  if (v.length === 0) pass('Booking hold → confirmation with service + time + YES prompt', `"${confirmReply}"`)
  else fail('Booking hold reply', `violations: ${v.join('; ')}\n       reply: "${confirmReply}"`)
}

await sleep(DELAY)
const heReply = await generateCustomerReply({
  businessName: 'מספרת נועה', language: 'he',
  situation: 'לקוח רוצה לקבוע תור, אבל לא ציין תאריך. בקש תאריך ספציפי.',
  transcript: [],
})
{
  const v = fmtCheck(heReply)
  const isHebrew = /[֐-׿]/.test(heReply)
  const hasEnglish = /\b(please|would you|the appointment|you can)\b/i.test(heReply)
  if (!isHebrew) v.push('not in Hebrew')
  if (hasEnglish) v.push('contains English words')
  if (v.length === 0) pass('Hebrew situation → pure Hebrew reply', `"${heReply}"`)
  else fail('Hebrew reply purity', `violations: ${v.join('; ')}\n       reply: "${heReply}"`)
}

// ══════════════════════════════════════════════════════════════════════════════
// DIM 8 — Onboarding: timezone and calendar steps (the two that failed)
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 8 — Onboarding explanation: timezone + calendar (Branch 2)')

for (const [step, userMsg, lang] of [
  ['timezone', 'מה זה timezone? אני לא מבין', 'he'],
  ['calendar', 'what does connecting Google Calendar actually do?', 'en'],
] as [string, string, 'he'|'en'][]) {
  await sleep(DELAY)
  const reply = await explainOnboardingConcept({ concept: step, userMessage: userMsg, step, lang })
  const v = fmtCheck(reply)
  const endsWithQ = /[?？]/.test(reply.slice(-100))
  const sentences = reply.split(/[.!?]+\s+/).filter(s => s.trim().length > 3).length
  if (!endsWithQ) v.push('does not end with re-ask question')
  if (sentences > 5) v.push(`${sentences} sentences — too long`)
  if (v.length === 0) pass(`'${step}' explanation — natural, ends with re-ask`, `"${reply.slice(0, 90)}…"`)
  else fail(`'${step}' explanation`, `violations: ${v.join('; ')}\n       reply: "${reply.slice(0, 90)}"`)
}

// ══════════════════════════════════════════════════════════════════════════════
// DIM 9 — Q4 and Q5 (the two that failed)
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 9 — Operator accuracy: Q4 escalations + Q5 full status')

const businesses = [
  { name: 'Salon Noa', phone: '+972501111111', status: 'live' as const, calendarMode: 'google' as const, googleCalendarConnected: true, calendarTokenExpired: false, openEscalations: 0, minutesSinceLastMsg: 15, hasWebsite: true, managerPhoneNumber: '+972507654321', calendarAuthStatus: 'ok' as const },
  { name: 'Barber Dan', phone: '+972502222222', status: 'live' as const, calendarMode: 'google' as const, googleCalendarConnected: true, calendarTokenExpired: true, openEscalations: 2, minutesSinceLastMsg: 300, hasWebsite: false, managerPhoneNumber: '+972508888888', calendarAuthStatus: 'expired' as const },
  { name: 'Pilates Studio', phone: '+972503333333', status: 'setup' as const, calendarMode: 'internal' as const, googleCalendarConnected: false, calendarTokenExpired: false, openEscalations: 0, minutesSinceLastMsg: null, hasWebsite: false, managerPhoneNumber: null, calendarAuthStatus: 'not_connected' as const },
]

await sleep(DELAY)
const q4 = await answerOperatorQuestion({ question: 'Any open escalations?', transcript: [], lang: 'en', businesses, openEscalationsTotal: 2 })
{
  const v = fmtCheck(q4)
  const mentionsTwo = /\b2\b|two/.test(q4)
  if (!mentionsTwo) v.push('does not mention count of 2')
  if (v.length === 0) pass('Q4: open escalations → mentions count 2', `"${q4}"`)
  else fail('Q4: escalations', `violations: ${v.join('; ')}\n       reply: "${q4}"`)
}

await sleep(DELAY)
const q5 = await answerOperatorQuestion({ question: 'Give me a status of all businesses', transcript: [], lang: 'en', businesses, openEscalationsTotal: 2 })
{
  const v = fmtCheck(q5)
  const mentionsAll3 = /salon noa/i.test(q5) && /barber dan/i.test(q5) && /pilates/i.test(q5)
  if (!mentionsAll3) v.push('does not mention all 3 businesses')
  if (v.length === 0) pass('Q5: full status mentions all 3 businesses, no bad formatting', `${q5.length} chars: "${q5.slice(0, 80)}…"`)
  else fail('Q5: full status', `violations: ${v.join('; ')}\n       reply: "${q5.slice(0, 120)}"`)
}

// ── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed
const pct = Math.round((passed / total) * 100)
console.log(`\n${'─'.repeat(60)}`)
console.log(`${HEAD}TARGETED TEST RESULTS${RESET}`)
console.log(`  ${PASS} Passed: ${passed} / ${FAIL} Failed: ${failed}`)
console.log(`  Score: ${passed}/${total} (${pct}%)  ${failed === 0 ? '✅ ALL PASS' : pct >= 80 ? '⚠️  MOSTLY PASS' : '❌ NEEDS WORK'}`)
if (failed > 0) process.exit(1)
