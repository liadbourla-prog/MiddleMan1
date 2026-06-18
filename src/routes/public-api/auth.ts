import crypto from 'crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { businessApiKeys } from '../../db/schema.js'

export type KeyType = 'publishable' | 'secret'
export type ApiScope = 'public' | 'secret'

export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function generateApiKey(type: KeyType): { raw: string; hash: string; prefix: string } {
  const tag = type === 'secret' ? 'sk' : 'pk'
  const raw = `${tag}_live_${crypto.randomBytes(24).toString('base64url')}`
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) }
}

export function extractBearer(request: FastifyRequest): string | null {
  const h = request.headers['authorization']
  if (!h || Array.isArray(h)) return null
  const m = /^Bearer (.+)$/.exec(h)
  return m ? m[1]!.trim() : null
}

export interface ResolvedKey { businessId: string; type: KeyType }

export async function resolveApiKey(db: Db, rawKey: string): Promise<ResolvedKey | null> {
  const [row] = await db
    .select({ businessId: businessApiKeys.businessId, type: businessApiKeys.type })
    .from(businessApiKeys)
    .where(
      and(
        eq(businessApiKeys.keyHash, hashApiKey(rawKey)),
        eq(businessApiKeys.isActive, true),
        isNull(businessApiKeys.revokedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

export function apiError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.status(status).send({ error: { code, message } })
}

/**
 * Authenticate + scope-check a request. Returns { businessId } or sends the error
 * envelope and returns null. `required: 'public'` accepts any valid key;
 * `required: 'secret'` requires a secret key (roster names + writes).
 */
export async function requireAuth(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  required: ApiScope,
): Promise<{ businessId: string } | null> {
  const raw = extractBearer(request)
  if (!raw) { apiError(reply, 401, 'unauthorized', 'Missing Bearer API key'); return null }
  const key = await resolveApiKey(db, raw)
  if (!key) { apiError(reply, 401, 'unauthorized', 'Invalid or revoked API key'); return null }
  if (required === 'secret' && key.type !== 'secret') {
    apiError(reply, 403, 'forbidden_scope', 'This endpoint requires a secret key')
    return null
  }
  return { businessId: key.businessId }
}
