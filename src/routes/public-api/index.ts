import type { FastifyInstance } from 'fastify'
import { db } from '../../db/client.js'
import { requireAuth, apiError } from './auth.js'

// Reads + bookings handlers are added in later tasks; this skeleton wires auth so
// the route group is registered and scope is enforced from the start.
export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  // Public read (stub until Task 3 fills it in)
  app.get('/api/v1/services', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'public')
    if (!auth) return
    return reply.send({ services: [] })
  })

  // Secret-scope write (stub until Task 5 fills it in)
  app.post('/api/v1/bookings', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'secret')
    if (!auth) return
    return apiError(reply, 501, 'not_implemented', 'Booking handler not yet implemented')
  })
}
