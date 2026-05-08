/**
 * Operator admin handler — runs on the provider number when the sender is OPERATOR_PHONE.
 * Gives the platform owner (us) cross-business visibility and bulk controls via WhatsApp.
 */

import { eq, isNull, and, desc, isNotNull, count } from 'drizzle-orm'
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
} from '../../db/schema.js'
import { classifyManagerInstruction, classifyOperatorMessage } from '../../adapters/llm/client.js'
import { applyInstruction } from '../manager/apply.js'
import { createWorkflow } from '../skills/workflow-helpers.js'
import { operatorCapabilityRegistry } from './operator-capability-registry.js'
import { detectLang, i18n, type Lang } from '../i18n/t.js'

export interface OperatorResult {
  reply: string
}

export async function handleOperatorMessage(
  db: Db,
  body: string,
): Promise<OperatorResult> {
  const text = body.trim()
  const upper = text.toUpperCase()
  const lang = detectLang(body)

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

  // ── Natural language fallback — keyword extraction (zero-latency, no LLM) ────

  if (/\bstatus\b/i.test(text) || /סטטוס/.test(text) || /\ball businesses\b/i.test(text)) {
    return handleStatusAll(db, lang)
  }
  if (/\bescalation/i.test(text) || /פניות/.test(text)) {
    return handleEscalations(db, lang)
  }

  // ── LLM fallback: classify intent and route, or answer conversationally ──────

  const [bizCountRow, escCountRow] = await Promise.all([
    db.select({ total: count() }).from(businesses).then((r) => r[0]),
    db.select({ total: count() }).from(escalatedTasks).where(isNull(escalatedTasks.resolvedAt)).then((r) => r[0]),
  ])
  const liveStats = {
    businessCount: bizCountRow?.total ?? 0,
    openEscalations: escCountRow?.total ?? 0,
  }

  const classified = await classifyOperatorMessage(text, lang, liveStats)
  if (!classified.ok) return { reply: i18n.op_help[lang] }

  const op = classified.data
  switch (op.action) {
    case 'status_all':  return handleStatusAll(db, lang)
    case 'status_one':  return op.businessName ? handleStatusOne(db, op.businessName, lang) : handleStatusAll(db, lang)
    case 'escalations': return handleEscalations(db, lang)
    case 'update_all':  return op.updateInstruction ? handleUpdateAll(db, op.updateInstruction, lang) : { reply: i18n.op_help[lang] }
    case 'skills_one':  return op.businessName ? handleSkillsOne(db, op.businessName, lang) : handleStatusAll(db, lang)
    case 'features':    return handleFeatures(db, lang)
    case 'retrigger':   return op.businessName ? handleRetrigger(db, op.businessName, op.skillName, lang) : { reply: i18n.op_help[lang] }
    case 'help':        return { reply: i18n.op_help[lang] }
    case 'general_qa':  return { reply: op.freeformReply ?? i18n.op_help[lang] }
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

  return { reply: lines.join('\n') }
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

  return {
    reply: [
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
    ].join('\n'),
  }
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

  return { reply: lines.join('\n') }
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

  return {
    reply: `${i18n.op_update_ok[lang](applied, liveBizRows.length)}${failureNote}`,
  }
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

  return { reply: lines.join('\n') }
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

  return { reply: lines.join('\n') }
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

  return { reply: i18n.op_retrigger_ok[lang](found.name, skillName) }
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

  return { reply: lines.join('\n') }
}
