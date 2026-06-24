// Autonomy repository (Phase 6.1; design §5) — the thin read/write side around the
// initiation_autonomy table. No decisions live here: the ratchet move is pure (ratchet.ts);
// this module only resolves the effective state and persists transitions.

import { eq, and } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { initiationAutonomy } from '../../db/schema.js'
import type { AutonomyState } from './ratchet.js'

export interface AutonomyRow {
  state: AutonomyState
  vetoed: boolean
  promotedAt: Date | null
}

/** Effective autonomy for a (business, category): the stored row, or the ai_proposed default. */
export async function resolveAutonomy(db: Db, businessId: string, category: string): Promise<AutonomyRow> {
  const [row] = await db
    .select({ state: initiationAutonomy.state, vetoed: initiationAutonomy.vetoed, promotedAt: initiationAutonomy.promotedAt })
    .from(initiationAutonomy)
    .where(and(eq(initiationAutonomy.businessId, businessId), eq(initiationAutonomy.category, category)))
    .limit(1)
  if (!row) return { state: 'ai_proposed', vetoed: false, promotedAt: null }
  return { state: row.state as AutonomyState, vetoed: row.vetoed, promotedAt: row.promotedAt }
}

/** Upsert the autonomy state for a (business, category). Sets promoted_at/demoted_at on transitions. */
export async function setAutonomyState(
  db: Db,
  businessId: string,
  category: string,
  state: AutonomyState,
  opts: { vetoed?: boolean } = {},
): Promise<void> {
  const now = new Date()
  const base = {
    state,
    updatedAt: now,
    ...(state === 'owner_configured' ? { promotedAt: now } : { demotedAt: now }),
    ...(opts.vetoed !== undefined ? { vetoed: opts.vetoed } : {}),
  }
  await db
    .insert(initiationAutonomy)
    .values({ businessId, category, ...base })
    .onConflictDoUpdate({
      target: [initiationAutonomy.businessId, initiationAutonomy.category],
      set: base,
    })
}
