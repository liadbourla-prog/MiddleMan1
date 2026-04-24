/**
 * Provisions a new business: creates DB rows and prints setup instructions.
 * Run once per business: npm run provision
 *
 * Required env vars:
 *   PROVISION_WA_NUMBER         — PA phone number in E.164 (e.g. +15550001234)
 *   PROVISION_MANAGER_PHONE     — Owner's personal WhatsApp number in E.164
 *   PROVISION_BUSINESS_NAME     — Business name (used internally; owner sets display name during onboarding)
 *   PROVISION_CALENDAR_ID       — Google Calendar ID (e.g. "primary" or email)
 *   PROVISION_TIMEZONE          — IANA timezone (e.g. "Asia/Jerusalem")
 *
 * Optional (per-business WA API credentials — overrides global env vars):
 *   PROVISION_WA_PHONE_NUMBER_ID — WhatsApp Phone Number ID from Meta Business Manager
 *   PROVISION_WA_ACCESS_TOKEN    — System User access token from Meta Business Manager
 */

import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, and } from 'drizzle-orm'
import * as schema from '../src/db/schema.js'

const PA_NUMBER = process.env['PROVISION_WA_NUMBER'] ?? ''
const MANAGER_PHONE = process.env['PROVISION_MANAGER_PHONE'] ?? ''
const BUSINESS_NAME = process.env['PROVISION_BUSINESS_NAME'] ?? 'My Business'
const CALENDAR_ID = process.env['PROVISION_CALENDAR_ID'] ?? ''
const TIMEZONE = process.env['PROVISION_TIMEZONE'] ?? 'UTC'
const WA_PHONE_NUMBER_ID = process.env['PROVISION_WA_PHONE_NUMBER_ID'] ?? null
const WA_ACCESS_TOKEN = process.env['PROVISION_WA_ACCESS_TOKEN'] ?? null

if (!PA_NUMBER || !MANAGER_PHONE) {
  console.error('PROVISION_WA_NUMBER and PROVISION_MANAGER_PHONE are required')
  process.exit(1)
}

if (!PA_NUMBER.startsWith('+')) {
  console.error('PROVISION_WA_NUMBER must be in E.164 format (e.g. +15550001234)')
  process.exit(1)
}

if (!MANAGER_PHONE.startsWith('+')) {
  console.error('PROVISION_MANAGER_PHONE must be in E.164 format')
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
  .where(eq(schema.businesses.whatsappNumber, PA_NUMBER))
  .limit(1)

if (!business) {
  ;[business] = await db
    .insert(schema.businesses)
    .values({
      name: BUSINESS_NAME,
      whatsappNumber: PA_NUMBER,
      whatsappPhoneNumberId: WA_PHONE_NUMBER_ID,
      whatsappAccessToken: WA_ACCESS_TOKEN,
      googleCalendarId: CALENDAR_ID || PA_NUMBER,
      timezone: TIMEZONE,
      onboardingStep: 'business_name',
    })
    .returning()

  console.log('✅ Business created:', business!.id, business!.name)
} else {
  // Update WA credentials if provided
  if (WA_PHONE_NUMBER_ID || WA_ACCESS_TOKEN) {
    await db
      .update(schema.businesses)
      .set({
        ...(WA_PHONE_NUMBER_ID ? { whatsappPhoneNumberId: WA_PHONE_NUMBER_ID } : {}),
        ...(WA_ACCESS_TOKEN ? { whatsappAccessToken: WA_ACCESS_TOKEN } : {}),
      })
      .where(eq(schema.businesses.id, business.id))
    console.log('✅ WA credentials updated for existing business:', business.id)
  } else {
    console.log('ℹ️  Business already exists:', business.id, business.name)
  }
}

const businessId = business!.id

// Upsert manager identity
const [existingManager] = await db
  .select()
  .from(schema.identities)
  .where(
    and(
      eq(schema.identities.businessId, businessId),
      eq(schema.identities.phoneNumber, MANAGER_PHONE),
    ),
  )
  .limit(1)

if (!existingManager) {
  await db.insert(schema.identities).values({
    businessId,
    phoneNumber: MANAGER_PHONE,
    role: 'manager',
    displayName: 'Owner',
  })
  console.log('✅ Manager identity created for:', MANAGER_PHONE)
} else {
  console.log('ℹ️  Manager identity already exists for:', MANAGER_PHONE)
}

await sql.end()

console.log('\n─────────────────────────────────────────')
console.log('Setup complete. Next steps:')
console.log('')
console.log('1. Confirm your webhook is configured in Meta Business Manager:')
console.log(`   URL: https://<your-domain>/webhook`)
console.log(`   Verify token: ${process.env['WHATSAPP_WEBHOOK_VERIFY_TOKEN'] ?? '<WHATSAPP_WEBHOOK_VERIFY_TOKEN>'}`)
console.log(`   Subscribed events: messages`)
console.log('')
console.log('2. Send this message to the PA number to begin onboarding:')
console.log(`   From: ${MANAGER_PHONE}`)
console.log(`   To:   ${PA_NUMBER}`)
console.log(`   Text: Hello`)
console.log('─────────────────────────────────────────')
