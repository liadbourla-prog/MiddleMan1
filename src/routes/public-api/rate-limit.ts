import type { FastifyRequest } from 'fastify'
import { extractBearer } from './auth.js'

// Rate-limit by API key (falling back to IP). Applied per-route via the route's
// `config.rateLimit` so the already-registered @fastify/rate-limit plugin
// (src/server.ts) honors it. Setting it on the route definition (not via a late
// onRoute hook) ensures the limit is present when the plugin reads it.
function keyGenerator(request: FastifyRequest): string {
  return extractBearer(request) ?? request.ip ?? 'anon'
}

export const readRateLimit = { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator } }
export const writeRateLimit = { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator } }
