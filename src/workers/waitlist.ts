import { Worker, Queue } from 'bullmq'
import { eq, and, asc, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { waitlist, identities, businesses, serviceTypes } from '../db/schema.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { redisConnection } from '../redis.js'
import { logAudit } from '../domain/audit/logger.js'

const QUEUE_NAME = 'waitlist'
const OFFER_TTL_MINUTES = parseInt(process.env['WAITLIST_OFFER_TTL_MINUTES'] ?? '15', 10)

export const waitlistQueue = new Queue<WaitlistJob>(QUEUE_NAME, { connection: redisConnection })

interface WaitlistJob {
  type: 'offer_slot' | 'expire_offer'
  waitlistId?: string
  businessId: string
  serviceTypeId: string
  slotStart: string
  slotEnd: string
}

export async function triggerWaitlistForSlot(
  businessId: string,
  serviceTypeId: string,
  slotStart: Date,
  slotEnd: Date,
): Promise<void> {
  await waitlistQueue.add(
    'offer_slot',
    {
      type: 'offer_slot',
      businessId,
      serviceTypeId,
      slotStart: slotStart.toISOString(),
      slotEnd: slotEnd.toISOString(),
    },
    { attempts: 2, backoff: { type: 'fixed', delay: 5_000 } },
  )
}

async function processJob(job: { data: WaitlistJob }) {
  const { type, businessId, serviceTypeId, slotStart, slotEnd, waitlistId } = job.data

  if (type === 'expire_offer') {
    if (!waitlistId) return
    const [entry] = await db
      .select()
      .from(waitlist)
      .where(and(eq(waitlist.id, waitlistId), eq(waitlist.status, 'offered')))
      .limit(1)

    if (!entry) return

    await db.update(waitlist).set({ status: 'expired' }).where(eq(waitlist.id, waitlistId))

    await logAudit(db, {
      businessId,
      actorId: null,
      action: 'waitlist.offer_expired',
      entityType: 'waitlist',
      entityId: waitlistId,
      metadata: { slotStart, slotEnd },
    })

    // Cascade to next in line
    await waitlistQueue.add('offer_slot', {
      type: 'offer_slot',
      businessId,
      serviceTypeId,
      slotStart,
      slotEnd,
    })
    return
  }

  // offer_slot: find the first pending waitlist entry FIFO and send them an offer
  const [next] = await db
    .select()
    .from(waitlist)
    .where(
      and(
        eq(waitlist.businessId, businessId),
        eq(waitlist.serviceTypeId, serviceTypeId),
        eq(waitlist.slotStart, new Date(slotStart)),
        eq(waitlist.status, 'pending'),
      ),
    )
    .orderBy(asc(waitlist.createdAt))
    .limit(1)

  if (!next) return // no one waiting

  const offerExpiresAt = new Date(Date.now() + OFFER_TTL_MINUTES * 60_000)

  await db
    .update(waitlist)
    .set({ status: 'offered', offeredAt: new Date(), offerExpiresAt })
    .where(eq(waitlist.id, next.id))

  const [customer] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(eq(identities.id, next.customerId))
    .limit(1)

  const [service] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, serviceTypeId))
    .limit(1)

  const [biz] = await db
    .select({ name: businesses.name, timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (customer && biz) {
    const dateStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: biz.timezone,
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(slotStart))

    await sendMessage({
      toNumber: customer.phoneNumber,
      body: `Great news! A slot opened up at ${biz.name}: ${service?.name ?? 'appointment'} on ${dateStr}. Reply YES to book it or NO to pass. This offer expires in ${OFFER_TTL_MINUTES} minutes.`,
    }).catch(() => { /* retry queue handles failures */ })
  }

  // Schedule expiry job
  await waitlistQueue.add(
    'expire_offer',
    { type: 'expire_offer', waitlistId: next.id, businessId, serviceTypeId, slotStart, slotEnd },
    { delay: OFFER_TTL_MINUTES * 60_000, attempts: 1 },
  )

  await logAudit(db, {
    businessId,
    actorId: null,
    action: 'waitlist.offer_sent',
    entityType: 'waitlist',
    entityId: next.id,
    metadata: { slotStart, offerExpiresAt },
  })
}

export function startWaitlistWorker() {
  const worker = new Worker<WaitlistJob>(
    QUEUE_NAME,
    async (job) => processJob(job),
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    console.error('[waitlist] Job failed', { jobId: job?.id, err: err.message })
  })

  return worker
}
