import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, serviceTypes } from '../../db/schema.js'

// Who set a booking in motion. Drives the owner-facing ground-truth wording in
// the action ledger (ledger-block.ts): a `customer_self` commit must be REFLECTED
// to the owner ("Yoni booked it himself"), never re-surfaced as a pending approval.
// See docs/superpowers/specs/2026-06-25-cross-branch-consistency-and-booking-authority-design.md.
export type BookingInitiator = 'customer_self' | 'owner' | 'pa_coordination'

// A manager/delegated actor acting on a customer's booking is an owner-side action;
// the customer acting on their own booking is self-service. Coordination passes its
// own initiator explicitly.
export function initiatorFromActor(actor: { role: string }): BookingInitiator {
  return actor.role === 'customer' ? 'customer_self' : 'owner'
}

// Build the renderable audit metadata for a booking action. Looks up the customer
// display name / service name only when the caller doesn't already have them in scope,
// so the hot self-book path stays query-free.
export async function buildBookingAuditMeta(
  db: Db,
  p: {
    customerId: string
    serviceTypeId: string
    slotStart: Date
    slotEnd?: Date
    initiator: BookingInitiator
    customerName?: string | null
    serviceName?: string | null
  },
): Promise<Record<string, unknown>> {
  let customerName = p.customerName ?? null
  if (!customerName) {
    const [c] = await db
      .select({ displayName: identities.displayName, phone: identities.phoneNumber })
      .from(identities)
      .where(eq(identities.id, p.customerId))
      .limit(1)
    customerName = c?.displayName ?? (c?.phone ? c.phone.slice(-4) : null)
  }

  let serviceName = p.serviceName ?? null
  if (!serviceName) {
    const [s] = await db
      .select({ name: serviceTypes.name })
      .from(serviceTypes)
      .where(eq(serviceTypes.id, p.serviceTypeId))
      .limit(1)
    serviceName = s?.name ?? null
  }

  return {
    customerName,
    customerId: p.customerId,
    serviceName,
    slotStart: p.slotStart.toISOString(),
    ...(p.slotEnd ? { slotEnd: p.slotEnd.toISOString() } : {}),
    initiator: p.initiator,
  }
}
