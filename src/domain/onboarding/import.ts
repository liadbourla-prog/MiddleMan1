import type { Db } from '../../db/client.js'
import { identities, customerProfiles, serviceTypes, bookings } from '../../db/schema.js'
import { eq, and } from 'drizzle-orm'

export interface ImportSummary {
  contacts: number
  services: number
  bookingHistory: number
  errors: string[]
}

export async function processImportFile(
  db: Db,
  businessId: string,
  filename: string,
  csvText: string,
): Promise<ImportSummary> {
  const summary: ImportSummary = { contacts: 0, services: 0, bookingHistory: 0, errors: [] }
  const rows = parseCsv(csvText)
  if (rows.length === 0) return summary

  const headers = rows[0]!.map((h) => h.toLowerCase().trim())

  if (headers.includes('phone') && headers.includes('name') && !headers.includes('date')) {
    await importContacts(db, businessId, headers, rows.slice(1), summary)
  } else if (headers.includes('name') && headers.includes('duration_minutes')) {
    await importServices(db, businessId, headers, rows.slice(1), summary)
  } else if (headers.includes('phone') && headers.includes('date') && headers.includes('service')) {
    await importBookingHistory(db, businessId, headers, rows.slice(1), summary)
  } else {
    summary.errors.push(`Unrecognized CSV format in "${filename}". Expected columns: (name, phone) or (name, duration_minutes) or (name, phone, date, service).`)
  }

  return summary
}

async function importContacts(
  db: Db,
  businessId: string,
  headers: string[],
  rows: string[][],
  summary: ImportSummary,
) {
  const nameIdx = headers.indexOf('name')
  const phoneIdx = headers.indexOf('phone')

  for (const row of rows) {
    const name = row[nameIdx]?.trim()
    const phone = normalizePhone(row[phoneIdx]?.trim() ?? '')
    if (!phone) continue

    try {
      const [existing] = await db
        .select({ id: identities.id })
        .from(identities)
        .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, phone)))
        .limit(1)

      let identityId: string
      if (existing) {
        identityId = existing.id
      } else {
        const [inserted] = await db
          .insert(identities)
          .values({ businessId, phoneNumber: phone, role: 'customer', displayName: name ?? null })
          .returning({ id: identities.id })
        identityId = inserted!.id
      }

      await db
        .insert(customerProfiles)
        .values({ businessId, identityId, displayName: name ?? null })
        .onConflictDoNothing()

      summary.contacts++
    } catch {
      summary.errors.push(`Failed to import contact ${phone}`)
    }
  }
}

async function importServices(
  db: Db,
  businessId: string,
  headers: string[],
  rows: string[][],
  summary: ImportSummary,
) {
  const nameIdx = headers.indexOf('name')
  const durationIdx = headers.indexOf('duration_minutes')
  const bufferIdx = headers.indexOf('buffer_minutes')
  const priceIdx = headers.indexOf('price')

  for (const row of rows) {
    const name = row[nameIdx]?.trim()
    const duration = parseInt(row[durationIdx] ?? '', 10)
    if (!name || isNaN(duration) || duration <= 0) continue

    try {
      const [existing] = await db
        .select({ id: serviceTypes.id })
        .from(serviceTypes)
        .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.name, name)))
        .limit(1)

      if (!existing) {
        await db.insert(serviceTypes).values({
          businessId,
          name,
          durationMinutes: duration,
          bufferMinutes: bufferIdx >= 0 ? (parseInt(row[bufferIdx] ?? '0', 10) || 0) : 0,
          requiresPayment: priceIdx >= 0 && parseFloat(row[priceIdx] ?? '0') > 0,
          paymentAmount: priceIdx >= 0 ? (row[priceIdx] ?? null) : null,
        })
        summary.services++
      }
    } catch {
      summary.errors.push(`Failed to import service "${name}"`)
    }
  }
}

async function importBookingHistory(
  db: Db,
  businessId: string,
  headers: string[],
  rows: string[][],
  summary: ImportSummary,
) {
  const nameIdx = headers.indexOf('name')
  const phoneIdx = headers.indexOf('phone')
  const dateIdx = headers.indexOf('date')
  const serviceIdx = headers.indexOf('service')

  for (const row of rows) {
    const name = row[nameIdx]?.trim()
    const phone = normalizePhone(row[phoneIdx]?.trim() ?? '')
    const dateStr = row[dateIdx]?.trim()
    const serviceName = row[serviceIdx]?.trim()
    if (!phone || !dateStr) continue

    try {
      const slotStart = new Date(dateStr)
      if (isNaN(slotStart.getTime())) continue

      const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000) // default 1h

      // Ensure identity exists
      let [identity] = await db
        .select({ id: identities.id })
        .from(identities)
        .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, phone)))
        .limit(1)

      if (!identity) {
        ;[identity] = await db
          .insert(identities)
          .values({ businessId, phoneNumber: phone, role: 'customer', displayName: name ?? null })
          .returning({ id: identities.id })
      }

      // Find service type if mentioned
      let serviceTypeId: string | null = null
      if (serviceName) {
        const [svc] = await db
          .select({ id: serviceTypes.id })
          .from(serviceTypes)
          .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.name, serviceName)))
          .limit(1)
        serviceTypeId = svc?.id ?? null
      }

      if (!serviceTypeId) {
        // Use first active service as fallback
        const [svc] = await db
          .select({ id: serviceTypes.id })
          .from(serviceTypes)
          .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.isActive, true)))
          .limit(1)
        serviceTypeId = svc?.id ?? null
      }

      if (!serviceTypeId || !identity) continue

      await db.insert(bookings).values({
        businessId,
        serviceTypeId,
        customerId: identity.id,
        requestedAt: slotStart,
        slotStart,
        slotEnd,
        state: 'confirmed',
        paymentStatus: 'not_required',
      }).onConflictDoNothing()

      summary.bookingHistory++
    } catch {
      summary.errors.push(`Failed to import booking for ${phone} on ${dateStr}`)
    }
  }
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '')
  if (!digits.startsWith('+')) return digits ? `+${digits}` : ''
  return digits
}

function parseCsv(text: string): string[][] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '').trim()),
    )
}
