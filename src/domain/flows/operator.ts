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
} from '../../db/schema.js'
import { classifyManagerInstruction } from '../../adapters/llm/client.js'
import { applyInstruction } from '../manager/apply.js'

export interface OperatorResult {
  reply: string
}

export async function handleOperatorMessage(
  db: Db,
  body: string,
): Promise<OperatorResult> {
  const text = body.trim()
  const upper = text.toUpperCase()

  if (upper === 'STATUS ALL' || upper === 'STATUS') {
    return handleStatusAll(db)
  }

  const statusMatch = text.match(/^STATUS\s+(.+)$/i)
  if (statusMatch) {
    return handleStatusOne(db, statusMatch[1]!.trim())
  }

  if (upper === 'ESCALATIONS') {
    return handleEscalations(db)
  }

  const updateMatch = text.match(/^UPDATE ALL:\s*(.+)$/is)
  if (updateMatch) {
    return handleUpdateAll(db, updateMatch[1]!.trim())
  }

  return {
    reply: [
      '🤖 *MiddleMan Operator Console*',
      '',
      'Commands:',
      '• `STATUS ALL` — health of all live businesses',
      '• `STATUS [name]` — detailed report for one business',
      '• `ESCALATIONS` — last 10 unresolved customer escalations',
      '• `UPDATE ALL: [instruction]` — push a change to every live agent',
    ].join('\n'),
  }
}

async function handleStatusAll(db: Db): Promise<OperatorResult> {
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
    return { reply: 'No businesses registered yet.' }
  }

  const lines: string[] = [`📊 *All Businesses (${allBusinesses.length})*`, '']

  for (const biz of allBusinesses) {
    const live = !!biz.onboardingCompletedAt
    const paused = biz.paused
    const calOk = biz.calendarMode === 'internal' || !!biz.googleRefreshToken

    const [lastMsg] = await db
      .select({ processedAt: processedMessages.processedAt })
      .from(processedMessages)
      .where(eq(processedMessages.businessId, biz.id))
      .orderBy(desc(processedMessages.processedAt))
      .limit(1)

    const lastMsgStr = lastMsg
      ? `${Math.round((Date.now() - lastMsg.processedAt.getTime()) / 60_000)}m ago`
      : 'never'

    const status = !live ? '⏳ onboarding' : paused ? '⏸ paused' : '✅ live'
    const cal = calOk ? '📅' : '❌ no cal'
    lines.push(`${status} *${biz.name}* (${biz.whatsappNumber}) ${cal} · last msg: ${lastMsgStr}`)
  }

  return { reply: lines.join('\n') }
}

async function handleStatusOne(db: Db, nameOrNumber: string): Promise<OperatorResult> {
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
    return { reply: `No business found matching "${nameOrNumber}".` }
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

  const calStatus = found.calendarMode === 'internal'
    ? '📅 Internal (DB)'
    : found.googleRefreshToken ? '📅 Google ✅' : '❌ Not connected'

  return {
    reply: [
      `📋 *${found.name}*`,
      `Number: ${found.whatsappNumber}`,
      `Status: ${!found.onboardingCompletedAt ? '⏳ Onboarding' : found.paused ? '⏸ Paused' : '✅ Live'}`,
      `Calendar: ${calStatus}`,
      `Confirmation: ${found.confirmationGate === 'post_payment' ? `💳 Post-payment (${found.paymentMethod ?? 'method not set'})` : '⚡ Immediate'}`,
      `Customers: ${customerRow?.total ?? 0}`,
      `Last booking: ${lastBooking ? lastBooking.slotStart.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'none'}`,
      `Last message: ${lastMsg ? `${Math.round((Date.now() - lastMsg.processedAt.getTime()) / 60_000)}m ago` : 'never'}`,
      `Pending instructions: ${pendingInstructions?.total ?? 0}`,
      `Open escalations: ${openEscalations?.total ?? 0}`,
    ].join('\n'),
  }
}

async function handleEscalations(db: Db): Promise<OperatorResult> {
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
    return { reply: '✅ No open escalations.' }
  }

  const bizIds = [...new Set(tasks.map((t) => t.businessId))]
  const bizRows = await db
    .select({ id: businesses.id, name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, bizIds[0]!))

  // Build a quick id→name map (good enough for ≤10 results)
  const bizMap = new Map<string, string>()
  for (const b of bizRows) bizMap.set(b.id, b.name)
  for (const t of tasks) {
    if (!bizMap.has(t.businessId)) {
      const [b] = await db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, t.businessId)).limit(1)
      if (b) bizMap.set(t.businessId, b.name)
    }
  }

  const lines = [`⚠️ *Open Escalations (${tasks.length})*`, '']
  for (const t of tasks) {
    const bizName = bizMap.get(t.businessId) ?? t.businessId
    const when = `${Math.round((Date.now() - t.receivedAt.getTime()) / 60_000)}m ago`
    const rule = t.triggerRule ? ` [${t.triggerRule}]` : ''
    lines.push(`• *${bizName}* — ${t.customerPhone}${rule} (${when})`)
    lines.push(`  "${t.messageBody.slice(0, 120)}"`)
  }

  return { reply: lines.join('\n') }
}

async function handleUpdateAll(db: Db, instruction: string): Promise<OperatorResult> {
  const liveBizRows = await db
    .select({ id: businesses.id, name: businesses.name, timezone: businesses.timezone })
    .from(businesses)
    .where(isNotNull(businesses.onboardingCompletedAt))

  if (liveBizRows.length === 0) {
    return { reply: 'No live businesses to update.' }
  }

  // Get a system actor id — use the first manager of the first business as proxy
  // (audit log requires an actorId; operator updates are sourced from us)
  const classifyResult = await classifyManagerInstruction(instruction, {
    timezone: 'UTC',
    updateAll: true,
  })

  if (!classifyResult.ok || classifyResult.data.ambiguous) {
    const clarification = classifyResult.ok ? classifyResult.data.clarificationNeeded : null
    return {
      reply: clarification
        ? `Clarification needed before applying to all agents: ${clarification}`
        : "Couldn't classify that instruction. Please rephrase.",
    }
  }

  const instructionData = classifyResult.data
  let applied = 0
  const failures: string[] = []

  for (const biz of liveBizRows) {
    // Find manager identity to use as actor
    const [manager] = await db
      .select({ id: identities.id })
      .from(identities)
      .where(and(eq(identities.businessId, biz.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
      .limit(1)

    if (!manager) continue

    // Insert instruction record
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
    )

    if (result.ok) {
      applied++
    } else {
      failures.push(`${biz.name}: ${result.reason}`)
    }
  }

  // Log the update
  await db.insert(agentUpdateLog).values({
    updateType: instructionData.instructionType,
    payload: instructionData as unknown as Record<string, unknown>,
    appliedToCount: applied,
  })

  const failureNote = failures.length > 0
    ? `\n\n⚠️ Failed on ${failures.length}:\n${failures.slice(0, 5).join('\n')}`
    : ''

  return {
    reply: `✅ Update applied to ${applied}/${liveBizRows.length} businesses.${failureNote}`,
  }
}
