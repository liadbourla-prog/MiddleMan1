/**
 * Escalation engine.
 *
 * Two escalation paths:
 * 1. Owner-rule: matches owner-configured triggers (keyword, emotional, unknown_intent threshold).
 *    → Notifies the business manager on their PA number.
 *    → Replies to customer per owner's customerMessage setting.
 *
 * 2. Platform: unknown intent after 2+ messages with no resolution.
 *    → Notifies the platform operator (OPERATOR_PHONE) via WhatsApp.
 *    → No customer message change (handled by caller).
 */

import { eq, and, isNull, lt } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { escalatedTasks, identities, pendingOwnerQuestions } from '../../db/schema.js'
import type { EscalationRule, Business } from '../../db/schema.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { i18n, type Lang } from '../i18n/t.js'
import { generateProactiveCustomerMessage } from '../../adapters/llm/client.js'
import { dispatchInitiation } from '../initiations/dispatch.js'
import { getInitiator } from '../initiations/registry.js'

export type EscalationCheckResult =
  | { escalated: false }
  | { escalated: true; customerReply: string | null; source: 'owner_rule' | 'platform' }

// ── Owner-rule escalation ─────────────────────────────────────────────────────

export async function checkOwnerEscalationRules(
  db: Db,
  business: Business,
  customerPhone: string,
  messageBody: string,
  detectedIntent: string,
  sessionUnknownCount: number,
  customerLang: Lang = 'he',
): Promise<EscalationCheckResult> {
  const rules = (business.escalationRules ?? []) as EscalationRule[]
  if (rules.length === 0) return { escalated: false }

  const lowerBody = messageBody.toLowerCase()
  const isEmotional = /frustrated|angry|upset|furious|ridiculous|unacceptable|terrible|horrible|awful|disgusting|hate|worst|never again|זועם|כועס|נורא|גרוע|מגעיל|שנוא|אף פעם|מאוכזב|מאוכזבת|לא מקובל|בושה|חרפה/i.test(messageBody)
  let matchedRule: EscalationRule | null = null

  for (const rule of rules) {
    if (rule.trigger === 'keyword' && rule.value) {
      if (lowerBody.includes(rule.value.toLowerCase())) {
        matchedRule = rule
        break
      }
    }
    if (rule.trigger === 'unknown_intent') {
      const threshold = rule.threshold ?? 1
      if (detectedIntent === 'unknown' && sessionUnknownCount >= threshold) {
        matchedRule = rule
        break
      }
    }
    if (rule.trigger === 'emotional' && (detectedIntent === 'emotional' || isEmotional)) {
      matchedRule = rule
      break
    }
  }

  if (!matchedRule) return { escalated: false }

  // Notify the business manager (look up their phone — escalation goes to manager, not customer)
  const [managerIdentity] = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  if (managerIdentity) {
    // Manager notification is always in the business default language (manager's language)
    const managerLang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
    const managerMessage = i18n.escalation_manager_notify[managerLang](customerPhone, messageBody.slice(0, 300))
    await dispatchInitiation(db, getInitiator('escalation.owner_rule'), {
      businessId: business.id,
      recipientId: managerIdentity.id,
      dedupKey: `escalation.owner_rule:${business.id}:${customerPhone}:${Date.now()}`,
    }, {
      sendFreeForm: async () => { await enqueueMessage(business.id, managerIdentity.phoneNumber, managerMessage).catch(() => {}) },
    }).catch(() => { /* non-fatal: a ledger/notify hiccup must not break the inbound escalation flow */ })
  }

  // Record escalation
  await db.insert(escalatedTasks).values({
    businessId: business.id,
    customerPhone,
    messageBody,
    receivedAt: new Date(),
    escalationType: 'owner_rule',
    triggerRule: matchedRule.trigger + (matchedRule.value ? `:${matchedRule.value}` : ''),
    forwardedAt: new Date(),
  }).catch(() => { /* non-fatal */ })

  const customerReply = await buildCustomerEscalationReply(matchedRule, business.name, customerLang)
  return { escalated: true, customerReply, source: 'owner_rule' }
}

// ── Unfulfillable-request escalation (P3) ─────────────────────────────────────

/**
 * The customer asked for something the catalog can't express on its own — a private
 * version of a group class, a group booking beyond a 1-on-1 service's capacity, or an
 * explicitly out-of-hours session. Notify the business owner so they can follow up, and
 * tell the customer it's been passed on (never a flat rejection). Best-effort: a missing
 * manager or notify hiccup never throws into the reply path.
 */
export async function escalateUnfulfillableRequest(
  db: Db,
  business: Business,
  customerPhone: string,
  requestText: string,
  customerLang: Lang = 'he',
): Promise<{ customerReply: string | null }> {
  const [managerIdentity] = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  if (managerIdentity) {
    const managerLang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
    const managerMessage = i18n.escalation_manager_notify_unfulfillable[managerLang](customerPhone, requestText.slice(0, 300))
    await dispatchInitiation(db, getInitiator('escalation.unfulfillable'), {
      businessId: business.id,
      recipientId: managerIdentity.id,
      dedupKey: `escalation.unfulfillable:${business.id}:${customerPhone}:${Date.now()}`,
    }, {
      sendFreeForm: async () => { await enqueueMessage(business.id, managerIdentity.phoneNumber, managerMessage).catch(() => {}) },
    }).catch(() => { /* non-fatal */ })
  }

  await db.insert(escalatedTasks).values({
    businessId: business.id,
    customerPhone,
    messageBody: requestText.slice(0, 300),
    receivedAt: new Date(),
    escalationType: 'unfulfillable',
    forwardedAt: new Date(),
  }).catch(() => { /* non-fatal */ })

  // Customer-facing: "passed to the studio, someone will be in touch" — never a rejection.
  const customerReply = await generateProactiveCustomerMessage({
    businessName: business.name,
    language: customerLang,
    situation: `The customer asked for a special arrangement we can't book automatically. Tell them warmly it's been passed to ${business.name} and someone will be in touch shortly — do NOT reject them or say it's impossible.`,
    fallback: i18n.escalation_customer_passed[customerLang](business.name),
    timeoutMs: 2500,
  })
  return { customerReply }
}

// ── Ask-the-owner question relay (F3a/S3) ─────────────────────────────────────

/**
 * A Branch-4 customer asked something the PA could not answer from business facts/FAQs.
 * Instead of fabricating "I'll check with the studio" (the reported bug), record the question
 * and ACTUALLY message the owner, so their later reply can be relayed back to the customer.
 *
 * Records the pending row FIRST (so the owner's reply can bind even if the notify retries),
 * then dispatches the owner message through the durable initiation path. Returns the honest
 * customer-facing reply ONLY when an owner exists and the question was recorded — the caller
 * must fall back to a non-committal reply (never claim an escalation) when `escalated` is false.
 */
export async function escalateCustomerQuestion(
  db: Db,
  business: Business,
  customer: { id: string; phoneNumber: string },
  questionText: string,
  customerLang: Lang = 'he',
): Promise<{ customerReply: string | null; escalated: boolean }> {
  const [managerIdentity] = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)
  // No reachable owner → we cannot honestly promise a follow-up. Signal not-escalated so the
  // caller gives a truthful "I don't have that" without claiming it asked anyone.
  if (!managerIdentity) return { customerReply: null, escalated: false }

  const trimmed = questionText.slice(0, 1000)
  const [row] = await db
    .insert(pendingOwnerQuestions)
    .values({
      businessId: business.id,
      customerId: customer.id,
      customerPhone: customer.phoneNumber,
      questionText: trimmed,
      status: 'pending',
      askedManagerId: managerIdentity.id,
    })
    .returning({ id: pendingOwnerQuestions.id })
  if (!row) return { customerReply: null, escalated: false }

  const managerLang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
  const managerMessage = i18n.owner_question_notify[managerLang](customer.phoneNumber, trimmed.slice(0, 300))
  await dispatchInitiation(db, getInitiator('question.relay'), {
    businessId: business.id,
    recipientId: managerIdentity.id,
    dedupKey: `question.relay:${row.id}`,
  }, {
    sendFreeForm: async () => { await enqueueMessage(business.id, managerIdentity.phoneNumber, managerMessage).catch(() => {}) },
  }).catch(() => { /* non-fatal: the row persists so the owner can still answer; reply stays honest */ })

  return { customerReply: i18n.question_passed_to_studio[customerLang](business.name), escalated: true }
}

/**
 * F3a/S3 — expire stale pending owner questions (created before `olderThan`) so a question
 * the owner never answered doesn't dangle forever. The customer was only ever told "they'll
 * get back to you", so an expiry needs no customer message. Returns the count expired.
 */
export async function expireStaleOwnerQuestions(db: Db, olderThan: Date): Promise<number> {
  const rows = await db
    .update(pendingOwnerQuestions)
    .set({ status: 'expired' })
    .where(and(eq(pendingOwnerQuestions.status, 'pending'), lt(pendingOwnerQuestions.createdAt, olderThan)))
    .returning({ id: pendingOwnerQuestions.id })
  return rows.length
}

// ── Platform escalation ───────────────────────────────────────────────────────

export async function escalateToPlatform(
  db: Db,
  business: Business,
  customerPhone: string,
  messageBody: string,
): Promise<void> {
  const operatorPhone = process.env['OPERATOR_PHONE']
  if (!operatorPhone) return

  const message = [
    `⚠️ *Unhandled request*`,
    `Business: ${business.name} (${business.whatsappNumber})`,
    `Customer: ${customerPhone}`,
    `Message: "${messageBody.slice(0, 300)}"`,
  ].join('\n')

  await dispatchInitiation(db, getInitiator('escalation.platform'), {
    businessId: business.id,
    recipientId: null,
    dedupKey: `escalation.platform:${business.id}:${customerPhone}:${Date.now()}`,
  }, {
    sendFreeForm: async () => { await enqueueMessage(business.id, operatorPhone, message, { useGlobalCredentials: true }).catch(() => {}) },
  }).catch(() => { /* non-fatal: a ledger/notify hiccup must not break platform escalation recording */ })

  await db.insert(escalatedTasks).values({
    businessId: business.id,
    customerPhone,
    messageBody,
    receivedAt: new Date(),
    escalationType: 'platform',
    forwardedAt: new Date(),
  }).catch(() => { /* non-fatal */ })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildCustomerEscalationReply(rule: EscalationRule, businessName: string, lang: Lang): Promise<string | null> {
  if (rule.customerMessage === 'silent' || rule.customerMessage === undefined) return null

  let situation: string
  let fallback: string

  switch (rule.customerMessage) {
    case 'passed_to_owner':
      situation = `The customer's message has been escalated. Tell them briefly that their message has been passed to ${businessName} and someone will be in touch shortly.`
      fallback = i18n.escalation_customer_passed[lang](businessName)
      break
    case 'owner_callback':
      situation = `The customer's message has been escalated. Tell them briefly that the team at ${businessName} will call them back shortly.`
      fallback = i18n.escalation_customer_callback[lang](businessName)
      break
    case 'custom':
      if (rule.customText) return rule.customText
      situation = `The customer's message has been escalated. Send a brief acknowledgement that we'll be in touch.`
      fallback = i18n.escalation_customer_default[lang]
      break
    default:
      return null
  }

  return generateProactiveCustomerMessage({
    businessName,
    language: lang,
    situation,
    fallback,
    timeoutMs: 2500,
  })
}
