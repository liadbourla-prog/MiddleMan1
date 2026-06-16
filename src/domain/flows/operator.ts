/**
 * Operator admin handler — runs on the provider number when the sender is OPERATOR_PHONE.
 * Gives the platform owner (us) cross-business visibility and bulk controls via WhatsApp.
 */

import { eq, isNull, and, desc, isNotNull, count, max } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import {
  businesses,
  identities,
  bookings,
  processedMessages,
  managerInstructions,
  escalatedTasks,
  agentUpdateLog,
  skillWorkflows,
  businessFaqs,
  deferredFeatureRequests,
  operatorSessionNotes,
} from '../../db/schema.js'
import { classifyManagerInstruction, classifyOperatorMessage, answerOperatorQuestion, formatOperatorDataReply, type CompactBusinessSummary } from '../../adapters/llm/client.js'
import { applyInstruction } from '../manager/apply.js'
import { createWorkflow } from '../skills/workflow-helpers.js'
import { operatorCapabilityRegistry } from './operator-capability-registry.js'
import { detectLang, i18n, type Lang } from '../i18n/t.js'
import { redis } from '../../redis.js'
import { loadOperatorSession, appendOperatorTurn } from '../session/operator-session.js'
import { enqueueOperatorSummary } from '../../workers/generate-operator-summary.js'
import { buildSignupUrl } from './provider-onboarding.js'
import { providerOnboardingSessions } from '../../db/schema.js'

export interface OperatorResult {
  reply: string
}

export async function handleOperatorMessage(
  db: Db,
  fromNumber: string,
  body: string,
): Promise<OperatorResult> {
  const text = body.trim()
  const upper = text.toUpperCase()
  const lang = detectLang(body)

  // Load session and record the inbound turn
  const operatorSession = await loadOperatorSession(redis, fromNumber)
  await appendOperatorTurn(redis, fromNumber, 'operator', text)

  // Load last 3 cross-session summaries for the operator
  const sessionNoteRows = await db
    .select({ summary: operatorSessionNotes.summary })
    .from(operatorSessionNotes)
    .orderBy(desc(operatorSessionNotes.createdAt))
    .limit(3)
  const sessionNotes = sessionNoteRows.map((r) => r.summary)

  // ── Route to a handler, then append assistant turn regardless of path ────────

  const result = await routeOperatorMessage(db, text, upper, lang, fromNumber, operatorSession, sessionNotes)
  await appendOperatorTurn(redis, fromNumber, 'assistant', result.reply).catch(() => {/* best-effort */})

  // Enqueue a summary of the session so far (idempotent — deduped by period start)
  const firstTurn = operatorSession.transcript[0]
  if (firstTurn) {
    const periodStart = new Date(firstTurn.ts)
    const periodEnd = new Date()
    const fullTranscript = [
      ...operatorSession.transcript,
      { role: 'assistant' as const, text: result.reply, ts: Date.now() },
    ]
    enqueueOperatorSummary(fullTranscript, periodStart, periodEnd).catch(() => {/* best-effort */})
  }

  return result
}

async function routeOperatorMessage(
  db: Db,
  text: string,
  upper: string,
  lang: Lang,
  fromNumber: string,
  operatorSession: Awaited<ReturnType<typeof loadOperatorSession>>,
  sessionNotes: string[],
): Promise<OperatorResult> {
  // ── Exact keyword matches (English & Hebrew aliases) ─────────────────────────

  if (
    upper === 'STATUS ALL' || upper === 'STATUS' ||
    /^סטטוס הכל$/.test(text) || /^סטטוס$/.test(text) ||
    /^הכל$/.test(text) || /^כל העסקים$/.test(text)
  ) {
    return handleStatusAll(db, lang)
  }

  // Website-specific query — show which businesses have a live site
  if (
    upper === 'WEBSITES' || upper === 'WEBSITE' ||
    /אתרים/.test(text) || /אתר/.test(text) ||
    /\bsite[s]?\b/i.test(text)
  ) {
    return handleWebsitesAll(db, lang)
  }

  const statusMatch = text.match(/^STATUS\s+(.+)$/i) ?? text.match(/^סטטוס\s+(.+)$/)
  if (statusMatch) {
    return handleStatusOne(db, statusMatch[1]!.trim(), lang)
  }

  if (
    upper === 'ESCALATIONS' || upper === 'ESCALATION' ||
    text === 'פניות' || text === 'פניה'
  ) {
    return handleEscalations(db, lang)
  }

  const updateMatch =
    text.match(/^UPDATE ALL:\s*(.+)$/is) ??
    text.match(/^עדכן הכל:\s*(.+)$/is) ??
    text.match(/^עדכן את כולם:\s*(.+)$/is)
  if (updateMatch) {
    return handleUpdateAll(db, updateMatch[1]!.trim(), lang)
  }

  const skillsMatch = text.match(/^SKILLS\s+(.+)$/i) ?? text.match(/^מיומנויות\s+(.+)$/)
  if (skillsMatch) {
    return handleSkillsOne(db, skillsMatch[1]!.trim(), lang)
  }

  if (upper === 'FEATURES' || upper === 'FEATURE' || text === 'פיצ\'רים' || text === 'פיצרים') {
    return handleFeatures(db, lang)
  }

  // Operator requests a test Embedded Signup link — match both keyword shorthand and natural language
  const isLinkRequest =
    // Exact keyword / shorthand. Lookahead (not a bare `\b`, which never matches
    // after Hebrew letters at end-of-input) so Hebrew keywords resolve.
    /^(link|test link|signup link|onboarding link|קישור|לינק)(?=\b|$|\s|[.,!?'"\-])/i.test(text) ||
    // Natural language: "send me the link", "שלח לי את הלינק", etc.
    /(שלח|תביא|תן|give|send|provide).*(לינק|קישור|link)/i.test(text) ||
    // Link type mentioned alongside signup / onboarding / system / test
    /(לינק|קישור|link).*(הרשמה|signup|onboard|התחבר|מערכת|system|בדיקה|test)/i.test(text) ||
    /(הרשמה|signup|onboard|התחבר|מערכת|system|בדיקה|test).*(לינק|קישור|link)/i.test(text)
  if (isLinkRequest) {
    return handleTestLink(db, fromNumber, lang)
  }

  const retriggerMatch = text.match(/^RETRIGGER\s+(.+)$/i) ?? text.match(/^הפעל מחדש\s+(.+)$/)
  if (retriggerMatch) {
    const raw = retriggerMatch[1]!.trim()
    const tokens = raw.split(/\s+/)
    const lastToken = tokens[tokens.length - 1] ?? ''
    // Skill names are always lowercase kebab-case — safe to distinguish from business names/phones
    const looksLikeSkillName = /^[a-z][a-z0-9-]+$/.test(lastToken) && tokens.length > 1
    const skillArg = looksLikeSkillName ? lastToken : null
    const businessArg = looksLikeSkillName ? tokens.slice(0, -1).join(' ') : raw
    return handleRetrigger(db, businessArg, skillArg, lang)
  }

  // ── LLM path: fetch live business data, classify intent, answer smartly ──────

  const [bizSummaries, escCountRow] = await Promise.all([
    fetchBusinessSummaries(db),
    db.select({ total: count() }).from(escalatedTasks).where(isNull(escalatedTasks.resolvedAt)).then((r) => r[0]),
  ])

  const openEscalationsTotal = Number(escCountRow?.total ?? 0)
  const liveStats = { businessCount: bizSummaries.length, openEscalations: openEscalationsTotal }

  // transcript is the pre-append snapshot (the inbound turn is written to redis but
  // not into this object), so an empty transcript is a genuine first-message signal.
  const isFirstMessage = operatorSession.transcript.length === 0

  async function smartAnswer(): Promise<OperatorResult> {
    const reply = await answerOperatorQuestion({
      question: text,
      transcript: operatorSession.transcript,
      lang,
      businesses: bizSummaries,
      openEscalationsTotal,
      sessionNotes,
      firstMessage: isFirstMessage,
    })
    return { reply: reply || i18n.op_help[lang] }
  }

  const classified = await classifyOperatorMessage(text, lang, liveStats)
  if (!classified.ok) return smartAnswer()

  const op = classified.data

  switch (op.action) {
    case 'update_all':  return op.updateInstruction ? handleUpdateAll(db, op.updateInstruction, lang) : { reply: i18n.op_help[lang] }
    case 'skills_one':  return op.businessName ? handleSkillsOne(db, op.businessName, lang) : smartAnswer()
    case 'features':    return handleFeatures(db, lang)
    case 'retrigger':   return op.businessName ? handleRetrigger(db, op.businessName, op.skillName, lang) : { reply: i18n.op_help[lang] }
    case 'escalations': return handleEscalations(db, lang)
    case 'status_one':  return op.businessName ? handleStatusOne(db, op.businessName, lang) : smartAnswer()
    case 'help':        return { reply: i18n.op_help[lang] }
    // status_all, general_qa, and any unrecognised action → smart data-augmented answer
    default:            return smartAnswer()
  }
}

async function handleStatusAll(db: Db, lang: Lang): Promise<OperatorResult> {
  const allBusinesses = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      whatsappNumber: businesses.whatsappNumber,
      onboardingCompletedAt: businesses.onboardingCompletedAt,
      paused: businesses.paused,
      calendarMode: businesses.calendarMode,
      googleRefreshToken: businesses.googleRefreshToken,
    })
    .from(businesses)
    .orderBy(businesses.createdAt)

  if (allBusinesses.length === 0) {
    return { reply: i18n.op_status_no_businesses[lang] }
  }

  const lines: string[] = [i18n.op_status_header[lang](allBusinesses.length), '']

  for (const biz of allBusinesses) {
    const live = !!biz.onboardingCompletedAt
    const calOk = biz.calendarMode === 'internal' || !!biz.googleRefreshToken

    const [lastMsg] = await db
      .select({ processedAt: processedMessages.processedAt })
      .from(processedMessages)
      .where(eq(processedMessages.businessId, biz.id))
      .orderBy(desc(processedMessages.processedAt))
      .limit(1)

    const minutesAgo = lastMsg
      ? Math.round((Date.now() - lastMsg.processedAt.getTime()) / 60_000)
      : null
    const lastMsgStr = minutesAgo !== null
      ? i18n.status_min_ago[lang](minutesAgo)
      : (lang === 'he' ? 'אף פעם' : 'never')

    const statusLabel = !live
      ? i18n.op_status_onboarding[lang]
      : biz.paused
        ? i18n.op_status_paused[lang]
        : i18n.op_status_live[lang]

    const cal = calOk ? '📅' : '❌'
    lines.push(`${statusLabel} *${biz.name}* (${biz.whatsappNumber}) ${cal} · ${lastMsgStr}`)
  }

  const rawReply = lines.join('\n')
  const formattedReply = await formatOperatorDataReply({
    question: 'STATUS ALL — overview of all businesses',
    dataBlock: rawReply,
    lang,
    fallback: rawReply,
  })
  return { reply: formattedReply }
}

async function handleStatusOne(db: Db, nameOrNumber: string, lang: Lang): Promise<OperatorResult> {
  const [biz] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.whatsappNumber, nameOrNumber))
    .limit(1)

  const found = biz ?? await db
    .select()
    .from(businesses)
    .then((all) => all.find((b) => b.name.toLowerCase().includes(nameOrNumber.toLowerCase())))

  if (!found) {
    return { reply: i18n.op_status_not_found[lang](nameOrNumber) }
  }

  const [customerRow] = await db
    .select({ total: count() })
    .from(identities)
    .where(and(eq(identities.businessId, found.id), eq(identities.role, 'customer')))

  const [lastBooking] = await db
    .select({ slotStart: bookings.slotStart })
    .from(bookings)
    .where(and(eq(bookings.businessId, found.id), eq(bookings.state, 'confirmed')))
    .orderBy(desc(bookings.slotStart))
    .limit(1)

  const [lastMsg] = await db
    .select({ processedAt: processedMessages.processedAt })
    .from(processedMessages)
    .where(eq(processedMessages.businessId, found.id))
    .orderBy(desc(processedMessages.processedAt))
    .limit(1)

  const [pendingInstructions] = await db
    .select({ total: count() })
    .from(managerInstructions)
    .where(and(eq(managerInstructions.businessId, found.id), eq(managerInstructions.applyStatus, 'pending')))

  const [openEscalations] = await db
    .select({ total: count() })
    .from(escalatedTasks)
    .where(and(eq(escalatedTasks.businessId, found.id), isNull(escalatedTasks.resolvedAt)))

  const [knowledgeWorkflow] = await db
    .select({ status: skillWorkflows.status })
    .from(skillWorkflows)
    .where(and(eq(skillWorkflows.businessId, found.id), eq(skillWorkflows.skillName, 'business-knowledge-setup')))
    .orderBy(desc(skillWorkflows.updatedAt))
    .limit(1)

  const calStatus = found.calendarMode === 'internal'
    ? i18n.status_cal_internal[lang]
    : found.googleRefreshToken
      ? i18n.status_cal_ok[lang]
      : i18n.status_cal_missing[lang]

  const confirmStatus = found.confirmationGate === 'post_payment'
    ? i18n.status_payment_post[lang](found.paymentMethod ?? (lang === 'he' ? 'לא הוגדר' : 'not set'))
    : i18n.status_payment_immediate[lang]

  const never = lang === 'he' ? 'אף פעם' : 'never'

  const lastBookingStr = lastBooking
    ? lastBooking.slotStart.toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : never

  const lastMsgStr = lastMsg
    ? i18n.status_min_ago[lang](Math.round((Date.now() - lastMsg.processedAt.getTime()) / 60_000))
    : never

  const statusLabel = !found.onboardingCompletedAt
    ? i18n.op_status_onboarding[lang]
    : found.paused
      ? i18n.op_status_paused[lang]
      : i18n.op_status_live[lang]

  const knowledgeStatus = !knowledgeWorkflow
    ? i18n.op_knowledge_none[lang]
    : knowledgeWorkflow.status === 'completed'
      ? i18n.op_knowledge_completed[lang]
      : knowledgeWorkflow.status === 'active'
        ? i18n.op_knowledge_active[lang]
        : i18n.op_knowledge_failed[lang]

  const L = lang === 'he'
    ? { number: 'מספר', status: 'סטטוס', calendar: 'לוח שנה', confirm: 'אישור', customers: 'לקוחות', lastBooking: 'תור אחרון', lastMsg: 'הודעה אחרונה', pending: 'הנחיות ממתינות', openEsc: 'פניות פתוחות', knowledge: i18n.op_knowledge_label.he }
    : { number: 'Number', status: 'Status', calendar: 'Calendar', confirm: 'Confirmation', customers: 'Customers', lastBooking: 'Last booking', lastMsg: 'Last message', pending: 'Pending instructions', openEsc: 'Open escalations', knowledge: i18n.op_knowledge_label.en }

  const rawStatusOne = [
    `📋 *${found.name}*`,
    `${L.number}: ${found.whatsappNumber}`,
    `${L.status}: ${statusLabel}`,
    `${L.calendar}: ${calStatus}`,
    `${L.confirm}: ${confirmStatus}`,
    `${L.customers}: ${customerRow?.total ?? 0}`,
    `${L.lastBooking}: ${lastBookingStr}`,
    `${L.lastMsg}: ${lastMsgStr}`,
    `${L.pending}: ${pendingInstructions?.total ?? 0}`,
    `${L.openEsc}: ${openEscalations?.total ?? 0}`,
    `${L.knowledge}: ${knowledgeStatus}`,
  ].join('\n')
  const formattedStatusOne = await formatOperatorDataReply({
    question: `STATUS ${found.name}`,
    dataBlock: rawStatusOne,
    lang,
    fallback: rawStatusOne,
  })
  return { reply: formattedStatusOne }
}

async function handleEscalations(db: Db, lang: Lang): Promise<OperatorResult> {
  const tasks = await db
    .select({
      id: escalatedTasks.id,
      businessId: escalatedTasks.businessId,
      customerPhone: escalatedTasks.customerPhone,
      messageBody: escalatedTasks.messageBody,
      escalationType: escalatedTasks.escalationType,
      triggerRule: escalatedTasks.triggerRule,
      receivedAt: escalatedTasks.receivedAt,
    })
    .from(escalatedTasks)
    .where(isNull(escalatedTasks.resolvedAt))
    .orderBy(desc(escalatedTasks.receivedAt))
    .limit(10)

  if (tasks.length === 0) {
    return { reply: i18n.op_escalations_none[lang] }
  }

  const bizMap = new Map<string, string>()
  for (const t of tasks) {
    if (!bizMap.has(t.businessId)) {
      const [b] = await db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, t.businessId)).limit(1)
      if (b) bizMap.set(t.businessId, b.name)
    }
  }

  const lines = [i18n.op_escalations_header[lang](tasks.length), '']
  for (const t of tasks) {
    const bizName = bizMap.get(t.businessId) ?? t.businessId
    const when = i18n.status_min_ago[lang](Math.round((Date.now() - t.receivedAt.getTime()) / 60_000))
    const rule = t.triggerRule ? ` [${t.triggerRule}]` : ''
    lines.push(`• *${bizName}* — ${t.customerPhone}${rule} (${when})`)
    lines.push(`  "${t.messageBody.slice(0, 120)}"`)
  }

  const rawEscalations = lines.join('\n')
  const formattedEscalations = await formatOperatorDataReply({
    question: 'ESCALATIONS — open escalations list',
    dataBlock: rawEscalations,
    lang,
    fallback: rawEscalations,
  })
  return { reply: formattedEscalations }
}

async function handleUpdateAll(db: Db, instruction: string, lang: Lang): Promise<OperatorResult> {
  const liveBizRows = await db
    .select({ id: businesses.id, name: businesses.name, timezone: businesses.timezone })
    .from(businesses)
    .where(isNotNull(businesses.onboardingCompletedAt))

  if (liveBizRows.length === 0) {
    return { reply: i18n.op_update_none[lang] }
  }

  const classifyResult = await classifyManagerInstruction(instruction, {
    timezone: 'UTC',
    updateAll: true,
  }, lang)

  if (!classifyResult.ok || classifyResult.data.ambiguous) {
    const clarification = classifyResult.ok ? classifyResult.data.clarificationNeeded : null
    return {
      reply: clarification
        ? i18n.op_update_clarify[lang](clarification)
        : i18n.op_update_classify_fail[lang],
    }
  }

  const instructionData = classifyResult.data
  let applied = 0
  const failures: string[] = []

  for (const biz of liveBizRows) {
    const [manager] = await db
      .select({ id: identities.id })
      .from(identities)
      .where(and(eq(identities.businessId, biz.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
      .limit(1)

    if (!manager) continue

    const [saved] = await db
      .insert(managerInstructions)
      .values({
        businessId: biz.id,
        identityId: manager.id,
        rawMessage: `[OPERATOR UPDATE] ${instruction}`,
        receivedAt: new Date(),
        classifiedAs: instructionData.instructionType as 'availability_change' | 'policy_change' | 'service_change' | 'permission_change' | 'unknown',
        structuredOutput: instructionData as unknown as Record<string, unknown>,
        applyStatus: 'pending',
      })
      .returning({ id: managerInstructions.id })

    if (!saved) continue

    const result = await applyInstruction(
      db,
      saved.id,
      biz.id,
      manager.id,
      instructionData.instructionType,
      instructionData.structuredParams as Record<string, unknown>,
      lang,
    )

    if (result.ok) {
      applied++
    } else {
      failures.push(`${biz.name}: ${result.reason}`)
    }
  }

  await db.insert(agentUpdateLog).values({
    updateType: instructionData.instructionType,
    payload: instructionData as unknown as Record<string, unknown>,
    appliedToCount: applied,
  })

  const failureNote = failures.length > 0
    ? `\n\n⚠️ ${lang === 'he' ? `נכשל ב-${failures.length}` : `Failed on ${failures.length}`}:\n${failures.slice(0, 5).join('\n')}`
    : ''

  const rawUpdateResult = `${i18n.op_update_ok[lang](applied, liveBizRows.length)}${failureNote}`
  const formattedUpdateResult = await formatOperatorDataReply({
    question: `UPDATE ALL: ${instruction}`,
    dataBlock: rawUpdateResult,
    lang,
    fallback: rawUpdateResult,
  })
  return { reply: formattedUpdateResult }
}

async function handleSkillsOne(db: Db, nameOrNumber: string, lang: Lang): Promise<OperatorResult> {
  const [biz] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.whatsappNumber, nameOrNumber))
    .limit(1)

  const found = biz ?? await db
    .select()
    .from(businesses)
    .then((all) => all.find((b) => b.name.toLowerCase().includes(nameOrNumber.toLowerCase())))

  if (!found) {
    return { reply: i18n.op_status_not_found[lang](nameOrNumber) }
  }

  const [workflows, faqRow, deferredRow, websiteRow] = await Promise.all([
    db
      .select({
        skillName: skillWorkflows.skillName,
        status: skillWorkflows.status,
        step: skillWorkflows.step,
        updatedAt: skillWorkflows.updatedAt,
      })
      .from(skillWorkflows)
      .where(eq(skillWorkflows.businessId, found.id))
      .orderBy(desc(skillWorkflows.updatedAt))
      .limit(20),
    db
      .select({ total: count() })
      .from(businessFaqs)
      .where(and(eq(businessFaqs.businessId, found.id), eq(businessFaqs.isActive, true))),
    db
      .select({ total: count() })
      .from(deferredFeatureRequests)
      .where(eq(deferredFeatureRequests.businessId, found.id)),
    db
      .select({ websitePreviewUrl: businesses.websitePreviewUrl, websiteUrl: businesses.websiteUrl })
      .from(businesses)
      .where(eq(businesses.id, found.id))
      .limit(1),
  ])

  const lines: string[] = [i18n.op_skills_header[lang](found.name), '']

  if (workflows.length === 0) {
    lines.push(i18n.op_skills_none[lang])
  } else {
    for (const wf of workflows) {
      const emoji = wf.status === 'completed' ? '✅' : wf.status === 'active' ? '🔄' : wf.status === 'failed' ? '❌' : '⏸'
      const when = i18n.status_min_ago[lang](Math.round((Date.now() - wf.updatedAt.getTime()) / 60_000))
      let line = `${emoji} *${wf.skillName}* · ${wf.step} (${when})`
      if (wf.skillName === 'website-builder' && wf.status === 'completed') {
        const siteUrl = websiteRow[0]?.websiteUrl ?? websiteRow[0]?.websitePreviewUrl ?? null
        if (siteUrl) line += `\n   🌐 ${siteUrl}`
      }
      lines.push(line)
    }
  }

  lines.push('')
  lines.push(i18n.op_skills_faqs[lang](faqRow?.[0]?.total ?? 0))
  lines.push(i18n.op_skills_deferred[lang](deferredRow?.[0]?.total ?? 0))

  const rawSkills = lines.join('\n')
  const formattedSkills = await formatOperatorDataReply({
    question: `SKILLS ${found.name}`,
    dataBlock: rawSkills,
    lang,
    fallback: rawSkills,
  })
  return { reply: formattedSkills }
}

async function handleFeatures(db: Db, lang: Lang): Promise<OperatorResult> {
  const requests = await db
    .select({
      id: deferredFeatureRequests.id,
      businessId: deferredFeatureRequests.businessId,
      rawText: deferredFeatureRequests.rawText,
      createdAt: deferredFeatureRequests.createdAt,
    })
    .from(deferredFeatureRequests)
    .orderBy(desc(deferredFeatureRequests.createdAt))
    .limit(15)

  if (requests.length === 0) {
    return { reply: i18n.op_features_none[lang] }
  }

  const bizIds = [...new Set(requests.map((r) => r.businessId))]
  const bizRows = await db
    .select({ id: businesses.id, name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, bizIds[0]!))

  const bizMap = new Map<string, string>()
  for (const b of bizRows) bizMap.set(b.id, b.name)
  for (const r of requests) {
    if (!bizMap.has(r.businessId)) {
      const [b] = await db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, r.businessId)).limit(1)
      if (b) bizMap.set(r.businessId, b.name)
    }
  }

  const lines = [i18n.op_features_header[lang](requests.length), '']
  for (const r of requests) {
    const bizName = bizMap.get(r.businessId) ?? r.businessId
    const when = i18n.status_min_ago[lang](Math.round((Date.now() - r.createdAt.getTime()) / 60_000))
    lines.push(`• *${bizName}* (${when})`)
    lines.push(`  "${r.rawText.slice(0, 140)}"`)
  }

  const rawFeatures = lines.join('\n')
  const formattedFeatures = await formatOperatorDataReply({
    question: 'FEATURES — deferred feature requests',
    dataBlock: rawFeatures,
    lang,
    fallback: rawFeatures,
  })
  return { reply: formattedFeatures }
}

async function handleRetrigger(db: Db, nameOrNumber: string, skillName: string | null, lang: Lang): Promise<OperatorResult> {
  const [biz] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.whatsappNumber, nameOrNumber))
    .limit(1)

  const found = biz ?? await db
    .select()
    .from(businesses)
    .then((all) => all.find((b) => b.name.toLowerCase().includes(nameOrNumber.toLowerCase())))

  if (!found) {
    return { reply: i18n.op_status_not_found[lang](nameOrNumber) }
  }

  if (!found.onboardingCompletedAt) {
    return { reply: i18n.op_retrigger_not_live[lang](found.name) }
  }

  // No skill specified — list all retriggerable skills from the registry
  if (!skillName) {
    const retriggerable = operatorCapabilityRegistry.filter((c) => c.retriggerable)
    const list = retriggerable.map((c) => `• \`${c.skillName}\``).join('\n')
    return { reply: i18n.op_retrigger_list[lang](found.name, list) }
  }

  // Validate against registry
  const capability = operatorCapabilityRegistry.find((c) => c.skillName === skillName && c.retriggerable)
  if (!capability?.retriggersFirstStep) {
    return { reply: i18n.op_retrigger_skill_unknown[lang](skillName) }
  }

  const [activeWorkflow] = await db
    .select({ id: skillWorkflows.id })
    .from(skillWorkflows)
    .where(and(
      eq(skillWorkflows.businessId, found.id),
      eq(skillWorkflows.skillName, skillName),
      eq(skillWorkflows.status, 'active'),
    ))
    .limit(1)

  if (activeWorkflow) {
    return { reply: i18n.op_retrigger_already_active[lang](found.name, skillName) }
  }

  const [manager] = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.businessId, found.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  if (!manager) {
    return { reply: i18n.op_retrigger_no_manager[lang](found.name) }
  }

  // Creates a skill_workflows row — does not touch the businesses table.
  // Operator channel is permitted to write to skill_workflows (see DEV_OPERATING_MODEL invariant note).
  await createWorkflow(db, found.id, manager.id, skillName, capability.retriggersFirstStep)

  const rawRetrigger = i18n.op_retrigger_ok[lang](found.name, skillName)
  const formattedRetrigger = await formatOperatorDataReply({
    question: `RETRIGGER ${found.name} ${skillName}`,
    dataBlock: rawRetrigger,
    lang,
    fallback: rawRetrigger,
  })
  return { reply: formattedRetrigger }
}

async function handleTestLink(db: Db, operatorPhone: string, lang: Lang): Promise<OperatorResult> {
  const crypto = await import('crypto')
  const signupState = crypto.randomUUID()

  // Upsert a minimal onboarding session so the OAuth callback can validate the state
  await db
    .insert(providerOnboardingSessions)
    .values({
      managerPhone: operatorPhone,
      step: 'credentials',
      collectedData: {
        businessName: 'Test Business',
        timezone: 'Asia/Jerusalem',
        calendarMode: 'internal',
        calendarId: null,
        services: [{ name: 'Test', durationMinutes: 30 }],
        language: lang,
        _wabaCase: '1',
        _signupState: signupState,
      } as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: providerOnboardingSessions.managerPhone,
      set: {
        step: 'credentials',
        completedAt: null,
        collectedData: {
          businessName: 'Test Business',
          timezone: 'Asia/Jerusalem',
          calendarMode: 'internal',
          calendarId: null,
          services: [{ name: 'Test', durationMinutes: 30 }],
          language: lang,
          _wabaCase: '1',
          _signupState: signupState,
        } as Record<string, unknown>,
        updatedAt: new Date(),
      },
    })

  const url = buildSignupUrl(signupState)
  const reply = lang === 'he'
    ? `🔗 קישור בדיקה להרשמת עסק:\n${url}\n\nתוקף: חד-פעמי. לחץ, השלם את ה-Embedded Signup, ותוצאת ה-provisioning תגיע אליך כאן.`
    : `🔗 Test business signup link:\n${url}\n\nSingle-use. Click, complete Embedded Signup, and provisioning result will come back here.`
  return { reply }
}

async function fetchBusinessSummaries(db: Db): Promise<CompactBusinessSummary[]> {
  const allBiz = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      phone: businesses.whatsappNumber,
      onboardingCompletedAt: businesses.onboardingCompletedAt,
      isPaused: businesses.paused,
      calendarMode: businesses.calendarMode,
      googleRefreshToken: businesses.googleRefreshToken,
    })
    .from(businesses)
    .orderBy(businesses.createdAt)

  if (allBiz.length === 0) return []

  const [escalationRows, websiteRows, lastMsgRows, managerRows] = await Promise.all([
    db
      .select({ businessId: escalatedTasks.businessId, cnt: count() })
      .from(escalatedTasks)
      .where(isNull(escalatedTasks.resolvedAt))
      .groupBy(escalatedTasks.businessId),
    db
      .select({ businessId: skillWorkflows.businessId })
      .from(skillWorkflows)
      .where(and(eq(skillWorkflows.skillName, 'website-builder'), eq(skillWorkflows.status, 'completed'))),
    db
      .select({ businessId: processedMessages.businessId, lastMsg: max(processedMessages.processedAt) })
      .from(processedMessages)
      .groupBy(processedMessages.businessId),
    db
      .select({ businessId: identities.businessId, phoneNumber: identities.phoneNumber })
      .from(identities)
      .where(and(eq(identities.role, 'manager'), isNull(identities.revokedAt))),
  ])

  const escalationMap = new Map(escalationRows.map((r) => [r.businessId, Number(r.cnt)]))
  const websiteSet = new Set(websiteRows.map((r) => r.businessId))
  const lastMsgMap = new Map(lastMsgRows.map((r) => [r.businessId, r.lastMsg]))
  const managerPhoneMap = new Map(managerRows.map((r) => [r.businessId, r.phoneNumber]))

  return allBiz.map((biz) => {
    const lastMsg = lastMsgMap.get(biz.id)
    const calendarMode = (biz.calendarMode ?? 'internal') as 'google' | 'internal'
    return {
      name: biz.name,
      phone: biz.phone ?? '',
      status: !biz.onboardingCompletedAt ? 'setup' : biz.isPaused ? 'paused' : 'live',
      calendarMode,
      googleCalendarConnected: calendarMode === 'internal' || !!biz.googleRefreshToken,
      calendarTokenExpired: false,
      hasWebsite: websiteSet.has(biz.id),
      openEscalations: escalationMap.get(biz.id) ?? 0,
      minutesSinceLastMsg: lastMsg ? Math.round((Date.now() - lastMsg.getTime()) / 60_000) : null,
      managerPhoneNumber: managerPhoneMap.get(biz.id) ?? null,
    }
  })
}

async function handleWebsitesAll(db: Db, lang: Lang): Promise<OperatorResult> {
  const rows = await db
    .select({
      businessId: skillWorkflows.businessId,
      status: skillWorkflows.status,
      updatedAt: skillWorkflows.updatedAt,
    })
    .from(skillWorkflows)
    .where(eq(skillWorkflows.skillName, 'website-builder'))
    .orderBy(desc(skillWorkflows.updatedAt))

  if (rows.length === 0) {
    return { reply: lang === 'he' ? 'אין עסקים עם אתר אינטרנט עדיין.' : 'No businesses have a website yet.' }
  }

  const bizIds = [...new Set(rows.map((r) => r.businessId))]
  const bizRows = await db
    .select({ id: businesses.id, name: businesses.name, websiteUrl: businesses.websiteUrl, websitePreviewUrl: businesses.websitePreviewUrl })
    .from(businesses)
    .where(eq(businesses.id, bizIds[0]!))

  const bizMap = new Map<string, { name: string; url: string | null }>()
  for (const b of bizRows) bizMap.set(b.id, { name: b.name, url: b.websiteUrl ?? b.websitePreviewUrl ?? null })

  for (const id of bizIds.slice(1)) {
    if (!bizMap.has(id)) {
      const [b] = await db.select({ id: businesses.id, name: businesses.name, websiteUrl: businesses.websiteUrl, websitePreviewUrl: businesses.websitePreviewUrl }).from(businesses).where(eq(businesses.id, id)).limit(1)
      if (b) bizMap.set(b.id, { name: b.name, url: b.websiteUrl ?? b.websitePreviewUrl ?? null })
    }
  }

  const completed = rows.filter((r) => r.status === 'completed')
  const active = rows.filter((r) => r.status === 'active')
  const failed = rows.filter((r) => r.status === 'failed')

  const header = lang === 'he'
    ? `🌐 *אתרי עסקים* — ${completed.length} פעיל, ${active.length} בבנייה, ${failed.length} נכשל`
    : `🌐 *Business Websites* — ${completed.length} live, ${active.length} building, ${failed.length} failed`

  const lines: string[] = [header, '']

  for (const r of completed) {
    const biz = bizMap.get(r.businessId)
    const url = biz?.url ? `\n   🔗 ${biz.url}` : ''
    lines.push(`✅ *${biz?.name ?? r.businessId}*${url}`)
  }
  for (const r of active) {
    lines.push(`🔄 *${bizMap.get(r.businessId)?.name ?? r.businessId}* — ${lang === 'he' ? 'בבנייה' : 'building'}`)
  }
  for (const r of failed) {
    lines.push(`❌ *${bizMap.get(r.businessId)?.name ?? r.businessId}* — ${lang === 'he' ? 'נכשל' : 'failed'}`)
  }

  const rawWebsites = lines.join('\n')
  const formattedWebsites = await formatOperatorDataReply({
    question: 'WEBSITES — business websites status',
    dataBlock: rawWebsites,
    lang,
    fallback: rawWebsites,
  })
  return { reply: formattedWebsites }
}
