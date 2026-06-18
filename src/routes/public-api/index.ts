import type { FastifyInstance } from 'fastify'
import { registerReadRoutes } from './reads.js'
import { registerBookingRoutes } from './bookings.js'

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  registerReadRoutes(app)
  registerBookingRoutes(app)
}
