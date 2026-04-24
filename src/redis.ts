import { Redis } from 'ioredis'

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'

// Shared connection for BullMQ — maxRetriesPerRequest must be null per BullMQ docs
export const redisConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
})
