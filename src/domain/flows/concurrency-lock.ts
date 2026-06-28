import { redis } from '../../redis.js'

const LOCK_TTL_MS = 30_000 // 30 seconds max hold
const QUEUE_TTL_S = 60     // pending entries expire after 60 seconds

function lockKey(businessId: string): string {
  return `lock:branch3:${businessId}`
}

function queueKey(businessId: string): string {
  return `queue:branch3:${businessId}`
}

/**
 * Acquire a per-business Redis lock for Branch 3 message handling.
 * Uses SET NX PX for atomic lock acquisition.
 * Returns the lock token on success, null if lock is already held.
 */
export async function acquireLock(businessId: string): Promise<string | null> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const result = await redis.set(lockKey(businessId), token, 'PX', LOCK_TTL_MS, 'NX')
  return result === 'OK' ? token : null
}

/**
 * Release the lock only if the token matches (prevents stale releases).
 */
export async function releaseLock(businessId: string, token: string): Promise<void> {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `
  await redis.eval(script, 1, lockKey(businessId), token)
}

/**
 * Enqueue a message to be processed after the current lock holder finishes.
 * Stores the messageId; the handler is responsible for re-reading and re-dispatching.
 */
export async function enqueueForBusiness(businessId: string, messageId: string): Promise<void> {
  const key = queueKey(businessId)
  await redis.rpush(key, messageId)
  await redis.expire(key, QUEUE_TTL_S)
}

/**
 * Dequeue the next pending messageId for a business, if any.
 */
export async function dequeueForBusiness(businessId: string): Promise<string | null> {
  const result = await redis.lpop(queueKey(businessId))
  return result ?? null
}

/**
 * Run fn while holding the per-business Branch 3 lock.
 * If the lock is already held, enqueues messageId for later processing and returns null.
 * Returns the result of fn, or null if the lock could not be acquired.
 */
export async function withBusinessLock<T>(
  businessId: string,
  messageId: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const token = await acquireLock(businessId)
  if (!token) {
    await enqueueForBusiness(businessId, messageId)
    return null
  }
  try {
    return await fn()
  } finally {
    await releaseLock(businessId, token)
  }
}

function customerLockKey(identityId: string): string {
  return `lock:customer:${identityId}`
}

// The customer lock holds across a full Branch-4 turn, which can run several LLM calls
// (intent extraction + genReply with up to two regenerations per output gate). Its TTL
// must comfortably exceed the slowest realistic handler so the lock does not auto-expire
// mid-turn and let a queued turn run concurrently (the race this lock prevents). Kept
// separate from LOCK_TTL_MS (Branch 3, 30s) which has a different — enqueue-on-contention
// — profile, so widening it here does not change the manager path.
const CUSTOMER_LOCK_TTL_MS = 60_000

async function acquireIdentityLock(identityId: string): Promise<string | null> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const result = await redis.set(customerLockKey(identityId), token, 'PX', CUSTOMER_LOCK_TTL_MS, 'NX')
  return result === 'OK' ? token : null
}

async function releaseIdentityLock(identityId: string, token: string): Promise<void> {
  const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
  await redis.eval(script, 1, customerLockKey(identityId), token)
}

/**
 * Run fn while holding a per-identity lock, SERIALIZING concurrent turns from the same
 * customer (a customer turn must not be dropped — unlike Branch 3, which enqueues). On
 * contention, poll for the lock up to ~8s; if still unavailable (a wedged holder), give
 * up the lock-wait and run anyway so the customer is never left unanswered. This fully
 * serializes turns separated by less than ~8s (the observed interleaving case); a handler
 * slower than the poll budget may run concurrently with the next queued turn — an accepted
 * tradeoff against ever leaving a customer waiting.
 */
export async function withIdentityLock<T>(identityId: string, fn: () => Promise<T>): Promise<T> {
  let token: string | null = null
  for (let i = 0; i < 40 && !token; i++) {
    token = await acquireIdentityLock(identityId)
    if (!token) await new Promise((r) => setTimeout(r, 200))
  }
  try {
    return await fn()
  } finally {
    if (token) await releaseIdentityLock(identityId, token)
  }
}
