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
    // 'emotional' trigger is set by caller if LLM flagged frustration
    if (rule.trigger === 'emotional' && detectedIntent === 'emotional') {
      matchedRule = rule
      break
    }
  }

  if (!matchedRule) return { escalated: false }

  // Notify the business manager (look up their phone — escalation goes to manager, not customer)
  const [managerIdentity] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  if (managerIdentity) {
    // Manager notification is always in the business default language (manager's language)
    const managerLang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
    const managerMessage = i18n.escalation_manager_notify[managerLang](customerPhone, messageBody.slice(0, 300))
    await enqueueMessage(managerIdentity.phoneNumber, managerMessage).catch(() => { /* non-fatal */ })
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

  const customerReply = buildCustomerReply(matchedRule, business.name, customerLang)
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

  await enqueueMessage(operatorPhone, message).catch(() => { /* non-fatal */ })

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

function buildCustomerReply(rule: EscalationRule, businessName: string, lang: Lang): string | null {
  switch (rule.customerMessage) {
    case 'silent':
      return null
    case 'passed_to_owner':
      return i18n.escalation_customer_passed[lang](businessName)
    case 'owner_callback':
      return i18n.escalation_customer_callback[lang](businessName)
    case 'custom':
      return rule.customText ?? i18n.escalation_customer_default[lang]
    default:
      return null
  }
}
