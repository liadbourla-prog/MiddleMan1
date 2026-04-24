/**
 * Creates the first business and manager identity rows.
 * Run once per environment: npm run seed
 *
 * Configure via env vars or edit the defaults below.
 */

import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/db/schema.js'

const BUSINESS_NAME = process.env['SEED_BUSINESS_NAME'] ?? 'My Business'
const BUSINESS_WA_NUMBER = process.env['SEED_WA_NUMBER'] ?? ''       // E.164, e.g. +15550001234
const BUSINESS_CALENDAR_ID = process.env['SEED_CALENDAR_ID'] ?? ''  // e.g. primary or email address
const BUSINESS_TIMEZONE = process.env['SEED_TIMEZONE'] ?? 'UTC'
const MANAGER_PHONE = process.env['SEED_MANAGER_PHONE'] ?? ''        // E.164
const MANAGER_NAME = process.env['SEED_MANAGER_NAME'] ?? 'Manager'

if (!BUSINESS_WA_NUMBER || !MANAGER_PHONE) {
  console.error('Set SEED_WA_NUMBER and SEED_MANAGER_PHONE before running')
  process.exit(1)
}

const connectionString = process.env['DATABASE_URL']
if (!connectionString) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const sql = postgres(connectionString)
const db = drizzle(sql, { schema })

// Upsert business
let [business] = await db
  .select()
  .from(schema.businesses)
  .where(eq(schema.businesses.whatsappNumber, BUSINESS_WA_NUMBER))
  .limit(1)

if (!business) {
  ;[business] = await db
    .insert(schema.businesses)
    .values({
      name: BUSINESS_NAME,
      whatsappNumber: BUSINESS_WA_NUMBER,
      googleCalendarId: BUSINESS_CALENDAR_ID || BUSINESS_WA_NUMBER,
      timezone: BUSINESS_TIMEZONE,
    })
    .returning()

  console.log('Business created:', business!.id, business!.name)
} else {
  console.log('Business already exists:', business.id, business.name)
}

const businessId = business!.id

// Upsert manager identity
let [manager] = await db
  .select()
  .from(schema.identities)
  .where(eq(schema.identities.phoneNumber, MANAGER_PHONE))
  .limit(1)

if (!manager) {
  ;[manager] = await db
    .insert(schema.identities)
    .values({
      businessId,
      phoneNumber: MANAGER_PHONE,
      role: 'manager',
      displayName: MANAGER_NAME,
    })
    .returning()

  console.log('Manager created:', manager!.id, manager!.phoneNumber)
} else {
  console.log('Manager already exists:', manager.id, manager.phoneNumber)
}

await sql.end()
