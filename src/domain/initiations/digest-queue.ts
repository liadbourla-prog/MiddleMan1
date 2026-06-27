import { and, eq, isNull, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { notificationDigestQueue } from '../../db/schema.js'
import type { NotificationEvent } from './notification-rules.js'

export interface DigestRow {
  id: string
  event: string
  payload: { summary: string }
}

/** Append one digest item. Best-effort caller; this resolves once written. */
export async function enqueueDigest(
  db: Db,
  businessId: string,
  event: NotificationEvent,
  payload: { summary: string }
): Promise<void> {
  await db.insert(notificationDigestQueue).values({ businessId, event, payload })
}

/** All not-yet-flushed digest rows for a business, oldest first. */
export async function fetchUnflushedDigests(db: Db, businessId: string): Promise<DigestRow[]> {
  const rows = await db
    .select({
      id: notificationDigestQueue.id,
      event: notificationDigestQueue.event,
      payload: notificationDigestQueue.payload,
    })
    .from(notificationDigestQueue)
    .where(and(eq(notificationDigestQueue.businessId, businessId), isNull(notificationDigestQueue.flushedAt)))
    .orderBy(notificationDigestQueue.createdAt)
  return rows.map((r) => ({ id: r.id, event: r.event, payload: r.payload as { summary: string } }))
}

/** Stamp rows flushed (idempotent). */
export async function markDigestsFlushed(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db
    .update(notificationDigestQueue)
    .set({ flushedAt: new Date() })
    .where(inArray(notificationDigestQueue.id, ids))
}

/** Businesses that currently have unflushed digest rows (for the worker to sweep even when daily briefing is off). */
export async function businessesWithPendingDigests(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ businessId: notificationDigestQueue.businessId })
    .from(notificationDigestQueue)
    .where(isNull(notificationDigestQueue.flushedAt))
  return rows.map((r) => r.businessId)
}
