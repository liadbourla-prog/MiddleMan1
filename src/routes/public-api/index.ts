import type { FastifyInstance } from 'fastify'
import { db } from '../../db/client.js'
import { requireAuth, apiError } from './auth.js'
import { registerReadRoutes } from './reads.js'

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  registerReadRoutes(app)

  // Secret-scope write (stub until Task 5 fills it in)
  app.post('/api/v1/bookings', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'secret')
    if (!auth) return
    return apiError(reply, 501, 'not_implemented', 'Booking handler not yet implemented')
  })
}
