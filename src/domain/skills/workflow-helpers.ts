import { eq, and } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { skillWorkflows, workflowStepLogs } from '../../db/schema.js'
import type { WorkflowState, StepResult } from '../../shared/skill-types.js'
import { sendMessage } from '../../adapters/whatsapp/sender.js'

export class WorkflowConflictError extends Error {
  constructor(skillName: string) {
    super(`Active workflow already exists for skill: ${skillName}`)
    this.name = 'WorkflowConflictError'
  }
}

export class WorkflowVersionConflictError extends Error {
  constructor(workflowId: string) {
    super(`Optimistic lock conflict on workflow: ${workflowId}`)
    this.name = 'WorkflowVersionConflictError'
  }
}

export async function createWorkflow(
  db: Db,
  businessId: string,
  identityId: string,
  skillName: string,
  firstStep: string,
  initialState: Record<string, unknown> = {},
): Promise<WorkflowState> {
  const [row] = await db
    .insert(skillWorkflows)
    .values({ businessId, identityId, skillName, step: firstStep, state: initialState, status: 'active', version: 1 })
    .returning()
  if (!row) throw new WorkflowConflictError(skillName)
  return { id: row.id, skillName: row.skillName, step: row.step, state: row.state as Record<string, unknown>, version: row.version }
}

export async function loadActiveWorkflow(db: Db, identityId: string): Promise<WorkflowState | null> {
  const [row] = await db
    .select()
    .from(skillWorkflows)
    .where(and(eq(skillWorkflows.identityId, identityId), eq(skillWorkflows.status, 'active')))
    .limit(1)
  if (!row) return null
  return { id: row.id, skillName: row.skillName, step: row.step, state: row.state as Record<string, unknown>, version: row.version }
}

export async function advanceWorkflow(
  db: Db,
  workflowId: string,
  step: string,
  state: Record<string, unknown>,
  expectedVersion: number,
): Promise<void> {
  const result = await db
    .update(skillWorkflows)
    .set({ step, state, version: expectedVersion + 1, updatedAt: new Date() })
    .where(and(eq(skillWorkflows.id, workflowId), eq(skillWorkflows.version, expectedVersion)))
    .returning({ id: skillWorkflows.id })

  if (result.length === 0) throw new WorkflowVersionConflictError(workflowId)
}

export async function completeWorkflow(db: Db, workflowId: string): Promise<void> {
  const [row] = await db
    .update(skillWorkflows)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(eq(skillWorkflows.id, workflowId))
    .returning({ skillName: skillWorkflows.skillName, state: skillWorkflows.state })

  // Proactive MiddleMan notification for website builds
  if (row?.skillName === 'website-builder') {
    const state = row.state as Record<string, unknown> | null
    const previewUrl = typeof state?.previewUrl === 'string' ? state.previewUrl : null
    const operatorPhone = process.env['OPERATOR_PHONE']
    if (operatorPhone) {
      const notice = `✅ Website built\nPreview: ${previewUrl ?? 'see SKILLS status'}`
      await sendMessage({ toNumber: operatorPhone, body: notice }).catch(() => {
        // Operator notification failure must not block workflow completion
      })
    }
  }
}

export async function failWorkflow(
  db: Db,
  workflowId: string,
  error: { code: string; message: string; recoverable: boolean },
  managerPhone: string,
  waCredentials?: { accessToken: string; phoneNumberId: string },
): Promise<void> {
  const [row] = await db
    .update(skillWorkflows)
    .set({ status: 'failed', state: { error }, updatedAt: new Date() })
    .where(eq(skillWorkflows.id, workflowId))
    .returning({ skillName: skillWorkflows.skillName })

  const skillName = row?.skillName ?? 'unknown'
  const notice = `⚠️ Skill workflow failed: ${skillName}\nError: ${error.message}\nRecoverable: ${error.recoverable ? 'yes' : 'no'}`
  await sendMessage({ toNumber: managerPhone, body: notice }, waCredentials).catch(() => {
    // Notification failure must not shadow the workflow failure itself
  })
}

export async function logStep(
  db: Db,
  workflowId: string,
  stepName: string,
  result: StepResult,
  meta: { inputSnapshot?: unknown; outputSnapshot?: unknown; latencyMs?: number; tokensUsed?: number } = {},
): Promise<void> {
  const cap = (v: unknown): unknown => {
    const s = JSON.stringify(v ?? null)
    return s.length > 10240 ? JSON.parse(s.slice(0, 10240) + '"[truncated]"') : v
  }
  await db.insert(workflowStepLogs).values({
    workflowId,
    stepName,
    status: result.status,
    inputSnapshot: meta.inputSnapshot !== undefined ? (cap(meta.inputSnapshot) as Record<string, unknown>) : null,
    outputSnapshot: meta.outputSnapshot !== undefined ? (cap(meta.outputSnapshot) as Record<string, unknown>) : null,
    latencyMs: meta.latencyMs ?? null,
    retryCount: result.retryCount ?? 0,
    errorContext: result.errorContext as Record<string, unknown> | null ?? null,
    tokensUsed: meta.tokensUsed ?? null,
  })
}
