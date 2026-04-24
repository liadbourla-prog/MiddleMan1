import type { Db } from '../../db/client.js'
import { auditLog } from '../../db/schema.js'

interface AuditEntry {
  businessId: string
  actorId: string | null
  action: string
  entityType: string
  entityId?: string
  beforeState?: Record<string, unknown>
  afterState?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export async function logAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    businessId: entry.businessId,
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    beforeState: (entry.beforeState as Record<string, unknown> | undefined) ?? null,
    afterState: (entry.afterState as Record<string, unknown> | undefined) ?? null,
    metadata: (entry.metadata as Record<string, unknown> | undefined) ?? null,
  })
}
