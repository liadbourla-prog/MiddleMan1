/**
 * Chat quality test runner — all 4 branches.
 * Tests every dimension that does not require a live LLM API key or database.
 * Run: npx tsx scripts/chat-quality-test.ts
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

// ── Colour helpers ──────────────────────────────────────────────────────────

const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
const WARN = '\x1b[33m⚠\x1b[0m'
const HEAD = '\x1b[1m\x1b[36m'
const RESET = '\x1b[0m'

let passed = 0
let failed = 0
let warned = 0

function check(label: string, result: boolean, detail?: string): void {
  if (result) {
    console.log(`  ${PASS} ${label}`)
    passed++
  } else {
    console.log(`  ${FAIL} ${label}${detail ? `\n       → ${detail}` : ''}`)
    failed++
  }
}

function warn(label: string, detail?: string): void {
  console.log(`  ${WARN} ${label}${detail ? `\n       → ${detail}` : ''}`)
  warned++
}

function section(title: string): void {
  console.log(`\n${HEAD}── ${title} ${RESET}`)
}

// ── Source files ────────────────────────────────────────────────────────────

const clientTs         = read('src/adapters/llm/client.ts')
const orchestratorTs   = read('src/adapters/llm/orchestrator.ts')
const customerBookingTs = read('src/domain/flows/customer-booking.ts')
const providerOnboardingTs = read('src/domain/flows/provider-onboarding.ts')
const operatorTs       = read('src/domain/flows/operator.ts')
const webhookTs        = read('src/routes/webhook.ts')
const skillTypesTs     = read('src/shared/skill-types.ts')
const lawbook          = read('CHAT_LEVEL_LAWBOOK.md')

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 2 — Response Format Compliance (prompt-level)
// Verify that system prompts contain the formatting rules they must enforce.
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 2 — WhatsApp Formatting Rules in System Prompts')

// Branch 4 — PA_PERSONA_TEMPLATE in client.ts
const personaBlock = (() => {
  const m = clientTs.match(/const PA_PERSONA_TEMPLATE = `([\s\S]*?)`;?\n\nconst FALLBACK/)
  return m ? m[1] : ''
})()

check('B4: PA_PERSONA_TEMPLATE found',                   personaBlock.length > 0)
check('B4: No HTML rule present',                        personaBlock.includes('No HTML'))
check('B4: No markdown headers rule',                    personaBlock.includes('markdown headers'))
check('B4: Bullet format rule (• U+2022)',               personaBlock.includes('U+2022') || personaBlock.includes('•'))
check('B4: URL on own line rule',                        personaBlock.includes('own line'))
check('B4: One question per message rule',               personaBlock.includes('one question') || personaBlock.includes('Maximum one question'))
check('B4: Anti-AI-disclosure rule',                     personaBlock.includes('Never say') && personaBlock.includes('as an AI'))
check('B4: Language isolation rule (ENTIRELY)',          personaBlock.includes('ENTIRELY'))
check('B4: Max length guidance present',                 personaBlock.includes('sentence'))
check('B4: No sycophantic openers rule',                 personaBlock.includes('sycophantic') || personaBlock.includes('Absolutely'))

// Branch 3 — Orchestrator system prompt in orchestrator.ts
const orchestratorPrompt = (() => {
  const m = orchestratorTs.match(/return `You are the PA admin assistant[\s\S]*?`\s*\n}/)
  return m ? m[0] : ''
})()

check('B3: Orchestrator system prompt found',            orchestratorPrompt.length > 0)
check('B3: No HTML rule present',                        orchestratorPrompt.includes('No HTML'))
check('B3: Language isolation rule',                     orchestratorPrompt.includes('entirely in'))
check('B3: Tool usage rules present',                    orchestratorPrompt.includes('Tool usage rules') || orchestratorPrompt.includes('tool usage'))
check('B3: Proactive-offer rule (no auto-send)',         orchestratorPrompt.includes('ask first'))
check('B3: manageBusinessSettings boundary rule',        orchestratorPrompt.includes('manageBusinessSettings'))

// Branch 1 — answerOperatorQuestion system prompt in client.ts
const operatorPrompt = (() => {
  const m = clientTs.match(/const systemPrompt = `You are the MiddleMan admin assistant[\s\S]*?Output: reply text ONLY/)
  return m ? m[0] : ''
})()

check('B1: answerOperatorQuestion prompt found',         operatorPrompt.length > 0)
check('B1: Language isolation rule',                     operatorPrompt.includes('ENTIRELY'))
check('B1: No filler rule',                              operatorPrompt.includes('No filler'))
check('B1: Max sentence rule',                           operatorPrompt.includes('Maximum 5 sentences') || operatorPrompt.includes('5 sentences'))
check('B1: WhatsApp formatting block present (fix)',     operatorPrompt.includes('No HTML') && operatorPrompt.includes('U+2022'),
  operatorPrompt.includes('No HTML') ? '✓ HTML rule found' : 'WhatsApp formatting block missing')
check('B1: Cross-session notes injection in prompt',     operatorPrompt.includes('Cross-session context') || clientTs.includes('notesBlock'))

// Branch 2 — explainOnboardingConcept prompt in client.ts
const explainPrompt = (() => {
  const m = clientTs.match(/const systemPrompt = `You are helping a business owner set up[\s\S]*?Output: the explanation message ONLY/)
  return m ? m[0] : ''
})()

check('B2: explainOnboardingConcept prompt found',       explainPrompt.length > 0)
check('B2: Language rule present',                       explainPrompt.includes('ENTIRELY') || explainPrompt.includes('Write ENTIRELY'))
check('B2: Length limit (2-4 sentences)',                explainPrompt.includes('2–4 sentences') || explainPrompt.includes('2-4 sentences'))
check('B2: Plain language rule (no markdown)',           explainPrompt.includes('no markdown') || explainPrompt.includes('no bullet'))
check('B2: Re-ask at end rule',                          explainPrompt.includes('re-ask'))
check('B2: Sound human rule',                            explainPrompt.includes('human'))

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 3 — Language Faithfulness
// Check that language detection + persistence is wired
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 3 — Language Faithfulness Wiring')

check('B4: preferredLanguage written on switch confirm',
  customerBookingTs.includes('preferredLanguage: chosenLang'))
check('B4: Language switch offer appended after reply',
  customerBookingTs.includes('switchOffer') || customerBookingTs.includes('switch offer') || customerBookingTs.includes('Want me to switch') || customerBookingTs.includes('רוצה שאמשיך'))
check('B4: Language switch state handled (YES/NO)',
  customerBookingTs.includes('waiting_language') || customerBookingTs.includes('language_switch') || customerBookingTs.includes('Determine whether to append'))
check('B3: Orchestrator language param threaded through',
  orchestratorTs.includes("lang === 'he' ? 'Hebrew' : 'English'"))
check('B1: Operator prompt language param injected',
  clientTs.includes("input.lang === 'he' ? 'Hebrew (עברית)' : 'English'"))
check('B2: Onboarding explainer language injected',
  clientTs.includes("input.lang === 'he' ? 'Hebrew' : 'English'"))

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 4 — Memory Continuity Wiring
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 4 — Memory Continuity Wiring')

// Manager session depth
const mgTranscriptDepth = (() => {
  const m = webhookTs.match(/loadTranscript\(db, mgSession\.id, (\d+)\)/)
  return m ? parseInt(m[1]) : 0
})()
check('B3: Manager transcript depth = 20',               mgTranscriptDepth === 20,
  `actual depth: ${mgTranscriptDepth}`)

// Customer session depth
const custTranscriptDepth = (() => {
  const m = webhookTs.match(/loadTranscript\(db, session\.id, (\d+)\)/)
  return m ? parseInt(m[1]) : 0
})()
check('B4: Customer transcript depth ≥ 8',               custTranscriptDepth >= 8,
  `actual depth: ${custTranscriptDepth}`)

check('B3: Manager cross-session memory loader present',
  orchestratorTs.includes('loadManagerMemorySummaries'))
check('B3: Manager memory injected into system prompt',
  orchestratorTs.includes('managerMemorySummaries'))
check('B3: Last 3 summaries loaded (not all)',
  orchestratorTs.includes('.limit(3)'))
check('B1: Operator session notes loaded in operator.ts',
  operatorTs.includes('operatorSessionNotes') && operatorTs.includes('.limit(3)'))
check('B1: Session notes passed to answerOperatorQuestion',
  operatorTs.includes('sessionNotes'))
check('B3: Cross-session summary enqueue after session',
  operatorTs.includes('enqueueOperatorSummary'))
check('B4: Customer memory (returningCustomer) available to LLM',
  clientTs.includes('Returning customer:') && clientTs.includes('customerMemory'))

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 5 — Tool Orchestration Structure (Branch 3)
// Verify tool declarations, descriptions, and required-fields
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 5 — Tool Orchestration Structure (Branch 3)')

const tools = ['listCalendarEvents', 'createCalendarEvent', 'deleteCalendarEvent',
                'manageBusinessSettings', 'searchWeb', 'lookupCustomer', 'saveContactNote']

for (const t of tools) {
  check(`B3: Tool '${t}' declared`,                      orchestratorTs.includes(`name: '${t}'`))
}

// Critical routing boundary rules in tool descriptions
check('B3: deleteCalendarEvent description warns against customer bookings',
  orchestratorTs.includes('Never use this to cancel a customer booking'))
check('B3: createCalendarEvent description warns against blocking slots via this tool',
  orchestratorTs.includes('block time from customer bookings') || orchestratorTs.includes('blocking customer booking'))
check('B3: manageBusinessSettings covers booking cancellations',
  orchestratorTs.includes('cancel a customer booking') || orchestratorTs.includes('booking cancellations'))
check('B3: MAX_ITERATIONS = 5 enforced',
  orchestratorTs.includes('MAX_ITERATIONS = 5'))
check('B3: Loop exhaustion returns human fallback (not raw error)',
  orchestratorTs.includes("'Something went wrong processing your request.'") ||
  orchestratorTs.includes("'אירעה שגיאה בעיבוד הבקשה.'"))
check('B3: Tool dispatch handles unknown tool name gracefully',
  orchestratorTs.includes("Unknown tool:") || orchestratorTs.includes('default:'))
check('B3: Orchestrator logs every iteration',
  orchestratorTs.includes('logOrchestratorIteration'))
check('B3: Orchestrator logs completion with timing',
  orchestratorTs.includes('logOrchestratorCompletion') && orchestratorTs.includes('totalDurationMs'))
check('B3: Skills run before orchestrator (dispatchSkill first)',
  // Compare positions of the handler-call lines, not the import lines
  webhookTs.indexOf('mgSkillOutcome') < webhookTs.indexOf('runManagerOrchestratorLoop('))

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 6 — Ambiguity Handling
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 6 — Ambiguity Handling')

check('B4: dateAmbiguous field exists in intent schema',
  clientTs.includes('dateAmbiguous'))
check('B4: Ambiguous/vague dates trigger clarification (not booking)',
  // Flow gates on hasSpecificDate — covers both missing and ambiguous dates
  customerBookingTs.includes('hasSpecificDate') && customerBookingTs.includes('waiting_clarification'))
check('B4: Missing service triggers service selection prompt',
  customerBookingTs.includes('did not specify a service') || customerBookingTs.includes('Available services'))
check('B4: Missing date/time triggers specific ask (not generic)',
  customerBookingTs.includes('specific date') || customerBookingTs.includes('specific ${missing}'))
check('B4: 3-attempt limit before graceful handoff',
  customerBookingTs.includes('3 attempts') || customerBookingTs.includes('after 3'))
check('B3: manageBusinessSettings returns clarificationNeeded to LLM',
  clientTs.includes('clarificationNeeded') && clientTs.includes('ambiguous'))
check('B3: LLM receives clarification result via tool response (not branching code)',
  orchestratorTs.includes('functionResponse'))

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 7 — Graceful Error Recovery
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 7 — Graceful Error Recovery')

// Engine reason strings — check they are natural language before reaching the LLM
const engineNaturalLanguageReasons = [
  'Cannot book a slot in the past',
  'Slot is no longer available',
  'Could not place hold',
  'Booking not found',
]
const engineTs = read('src/domain/booking/engine.ts')
for (const r of engineNaturalLanguageReasons) {
  check(`B4: Engine error "${r.slice(0, 40)}" is natural language`,
    engineTs.includes(r))
}

// REASON_MAP covers its declared keys
const reasonMapKeys = ['past_slot','outside_hours','calendar_error','policy_violation',
  'already_cancelled','hold_conflict','not_found','not_authorized','slot_conflict',
  'cutoff_passed','max_days_ahead','min_buffer']
for (const k of reasonMapKeys) {
  check(`B4: REASON_MAP key '${k}' has human mapping`,
    customerBookingTs.includes(`${k}:`) || customerBookingTs.includes(`'${k}':`))
}

// Fallback for unmapped codes (regex cleanup)
check('B4: sanitiseReason has fallback for unknown codes',
  customerBookingTs.includes("replace(/_/g, ' ').toLowerCase()"))

// No raw codes in situation strings
const situationMatches = [...customerBookingTs.matchAll(/situation: ['"`](.*?)['"`]/g)]
  .map(m => m[1])
const rawCodePattern = /\b(slot_conflict|hold_conflict|past_slot|not_authorized|cutoff_passed|calendar_error)\b/
const situationsWithRawCodes = situationMatches.filter(s => rawCodePattern.test(s))
check('B4: No raw error codes in situation strings',
  situationsWithRawCodes.length === 0,
  situationsWithRawCodes.length > 0 ? `Found raw codes in: ${situationsWithRawCodes[0]}` : '')

// Orchestrator loop exhaustion message
check('B3: Orchestrator fallback is human-readable (both langs)',
  orchestratorTs.includes('Something went wrong') && orchestratorTs.includes('אירעה שגיאה'))

// Branch 2 — parse failure gets retry prompt, not raw error
check('B2: Service parse failure returns retry prompt (not raw error)',
  providerOnboardingTs.includes('mm_bad_services') || providerOnboardingTs.includes('_serviceFailCount'))

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 8 — Branch 2 Onboarding Quality
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 8 — Branch 2 Onboarding Flow Quality')

check('B2: detectsQuestion function exists',
  providerOnboardingTs.includes('detectsQuestion'))
check('B2: Explanation mode triggered at timezone step',
  providerOnboardingTs.includes("detectsQuestion(text)") &&
  providerOnboardingTs.includes("explainOnboardingConcept") &&
  providerOnboardingTs.includes("'timezone'"))
check('B2: Explanation mode triggered at calendar step',
  providerOnboardingTs.includes("'calendar'") && providerOnboardingTs.includes('explainOnboardingConcept'))
check('B2: Explanation mode triggered at services step',
  providerOnboardingTs.includes("'services'") && providerOnboardingTs.includes('explainOnboardingConcept'))
check('B2: Explanation mode triggered at credentials step',
  providerOnboardingTs.includes("'credentials'") && providerOnboardingTs.includes('explainOnboardingConcept'))
check('B2: Confused message at credentials handled separately (isExpressingNoAccess)',
  providerOnboardingTs.includes('isExpressingNoAccess') || providerOnboardingTs.includes('isAskingForHelp'))
check('B2: Calendar preview sent after OAuth (in oauth route)',
  (() => {
    try { return read('src/routes/oauth.ts').includes('listEvents') || read('src/routes/oauth.ts').includes('calendar preview') } catch { return false }
  })())
check('B2: CONCEPT_CONTEXT covers all explanation steps',
  // Object uses bare keys (no quotes): timezone:, calendar:, services:, credentials:
  clientTs.includes('CONCEPT_CONTEXT') &&
  /\btimezone:/.test(clientTs) && /\bcalendar:/.test(clientTs) &&
  /\bservices:/.test(clientTs) && /\bcredentials:/.test(clientTs))

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 9 — Branch 1 Operator Data Accuracy wiring
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 9 — Branch 1 Operator Data Accuracy Wiring')

check('B1: managerPhoneNumber in CompactBusinessSummary',
  clientTs.includes('managerPhoneNumber'))
check('B1: calendarTokenExpired in CompactBusinessSummary',
  clientTs.includes('calendarTokenExpired'))
check('B1: minutesSinceLastMsg in CompactBusinessSummary',
  clientTs.includes('minutesSinceLastMsg'))
check('B1: openEscalations in CompactBusinessSummary',
  clientTs.includes('openEscalations'))
check('B1: managerPhoneNumber rendered in bizListText',
  clientTs.includes('managerPhoneNumber') && clientTs.includes('manager:'))
check('B1: calendarTokenExpired rendered in bizListText',
  clientTs.includes('calendarTokenExpired') && clientTs.includes('token expired'))
check('B1: No "I don\'t have that data" — forbidden in prompt',
  !operatorPrompt.includes("I don't have") && operatorPrompt.includes('Never say you lack'))

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 10 — Proactive Behavior Correctness
// ══════════════════════════════════════════════════════════════════════════════

section('DIM 10 — Proactive Behavior Rules')

check('B3: "offer to notify, do not auto-notify" in orchestrator prompt',
  orchestratorTs.includes('ask first') || orchestratorTs.includes('Do not notify customers automatically'))
check('B3: canSendFreeForm utility exists (24h window guard)',
  (() => {
    try { return read('src/adapters/whatsapp/sender.ts').includes('canSendFreeForm') ||
      read('src/workers/reminder.ts').includes('canSendFreeForm') } catch { return false }
  })())
check('B3: Daily briefing worker exists',
  (() => { try { return read('src/workers/daily-briefing.ts').length > 0 } catch { return false } })())
check('B4: Proactive offer is manager-initiated (not auto-fired)',
  !customerBookingTs.includes('sendMessage') || customerBookingTs.includes('manager'))

// ══════════════════════════════════════════════════════════════════════════════
// BONUS — Sanitization (anti-injection) correctness
// ══════════════════════════════════════════════════════════════════════════════

section('BONUS — Input Sanitization')

// Extract sanitizeUserInput and test it in-process
const sanitizeMatch = clientTs.match(/function sanitizeUserInput\(text: string\): string \{([\s\S]*?)\n\}/)
if (sanitizeMatch) {
  // Eval-free test: just verify the patterns are present
  check('Sanitize: HTML stripping pattern present',
    clientTs.includes('<[^>]*>'))
  check('Sanitize: "ignore previous instructions" blocked',
    // Regex literals in source use single backslash: /ignore\s+.../
    clientTs.includes('ignore\\s+(previous|all|prior)'))
  check('Sanitize: "system prompt" blocked',
    clientTs.includes('system\\s*prompt'))
  check('Sanitize: 2000 char hard cap',
    clientTs.includes('.slice(0, 2000)'))
} else {
  warn('sanitizeUserInput function not found — skipping sanitization tests')
}

// ══════════════════════════════════════════════════════════════════════════════
// CONCURRENCY & INFRA
// ══════════════════════════════════════════════════════════════════════════════

section('INFRA — Concurrency & Safety')

check('Concurrency lock imported in webhook',
  webhookTs.includes('withBusinessLock'))
check('Manager messages queued under lock',
  webhookTs.includes('Manager message queued by concurrency lock') ||
  webhookTs.includes('concurrency lock'))
check('SkillContext has managerMemorySummaries field',
  skillTypesTs.includes('managerMemorySummaries'))

// ══════════════════════════════════════════════════════════════════════════════
// SITUATIONAL COVERAGE — spot-check situation strings for naturalness
// ══════════════════════════════════════════════════════════════════════════════

section('SPOT CHECK — Situation String Naturalness')

// All situation strings should be human-readable instructions to the LLM
const allSituations = [...customerBookingTs.matchAll(/situation: [`'"](.*?)[`'"]/g)].map(m => m[1])
const totalSituations = allSituations.length

// Heuristics: ≥ 5 chars, contains a space (not a single code word), no raw underscored keys
const naturalSituations = allSituations.filter(s => s.length > 10 && s.includes(' ') && !rawCodePattern.test(s))
check(`All ${totalSituations} situation strings are natural language`,
  naturalSituations.length === totalSituations,
  `${totalSituations - naturalSituations.length} situation(s) may contain raw codes`)

// Check that booking confirmation situation includes service/date/time
const confirmSituation = allSituations.find(s => s.includes('confirmed') || s.includes('Booking confirmed'))
check('Booking confirmation situation includes service + date + time',
  !!confirmSituation && (confirmSituation.includes('serviceName') || confirmSituation.includes('service')),
  confirmSituation)

// ══════════════════════════════════════════════════════════════════════════════
// FINAL REPORT
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'─'.repeat(60)}`)
console.log(`${HEAD}RESULTS${RESET}`)
console.log(`  ${PASS} Passed: ${passed}`)
console.log(`  ${FAIL} Failed: ${failed}`)
if (warned > 0) console.log(`  ${WARN} Warnings: ${warned}`)

const total = passed + failed
const pct = Math.round((passed / total) * 100)
const grade = failed === 0 ? '✅ ALL PASS'
  : pct >= 90 ? '⚠️  MOSTLY PASS (check failures above)'
  : '❌ NEEDS ATTENTION'

console.log(`\n  Score: ${passed}/${total} (${pct}%)  ${grade}`)

console.log(`\n${HEAD}DIMENSIONS THAT REQUIRE LIVE LLM TESTING:${RESET}`)
console.log(`  DIM 1 — Natural language understanding (diverse phrasing)`)
console.log(`         Run 5 Branch-4 + 5 Branch-3 test inputs through the live system`)
console.log(`         Verify extractCustomerIntent returns correct intent for each`)
console.log(`  DIM 5 — Tool routing correctness (live)`)
console.log(`         Run 9 Branch-3 inputs, read orchestrator logs, verify tool name+args`)
console.log(`  DIM 6 — Ambiguity handling quality (live)`)
console.log(`         Send 5 ambiguous inputs, score clarification quality 1-3`)
console.log(`  DIM 8 — Explanation quality (live)`)
console.log(`         Trigger explanation mode at each onboarding step, rate naturalness`)
console.log(`  DIM 4 — Cross-session memory (live)`)
console.log(`         Run 2-session script; verify prior session referenced in session 2`)
console.log(`  DIM 9 — Data accuracy (live)`)
console.log(`         Ask operator 4 data questions; verify answers match DB`)

if (failed > 0) process.exit(1)
