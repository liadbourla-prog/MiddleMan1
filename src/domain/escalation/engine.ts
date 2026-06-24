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

import { eq, and, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { escalatedTasks, identities } from '../../db/schema.js'
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
      sendFreeForm: async () => { await enqueueMessage(managerIdentity.phoneNumber, managerMessage).catch(() => {}) },
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
    sendFreeForm: async () => { await enqueueMessage(operatorPhone, message).catch(() => {}) },
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
