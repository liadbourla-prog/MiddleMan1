/**
 * Backfill the per-WABA WhatsApp template catalog into every already-provisioned business.
 * Run once after a business's WABA id has been captured (or after adding new templates to
 * src/adapters/whatsapp/templates.ts): npm run backfill:templates
 *
 * Idempotent — wraps provisionAllBusinesses, which creates-or-confirms each catalog template
 * per WABA via the Graph API and upserts the wa_template_provisioning ledger ("already exists"
 * counts as success). Businesses with no WABA id / access token are skipped (skippedReason).
 *
 * Connects via DATABASE_URL, same as `npm run db:apply`. Locally:
 *   ./cloud-sql-proxy deepr-490316:europe-west3:deepr-project --port 5433 &
 *   DATABASE_URL="postgres://USER:PASS@127.0.0.1:5433/DBNAME" npm run backfill:templates
 */

import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/db/schema.js'
import { provisionAllBusinesses } from '../src/adapters/whatsapp/template-provisioning.js'

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const sql = postgres(DATABASE_URL, { max: 1 })
const db = drizzle(sql, { schema })

try {
  const results = await provisionAllBusinesses(db as unknown as Parameters<typeof provisionAllBusinesses>[0])

  if (results.length === 0) {
    console.log('ℹ️  No businesses with a WABA id found — nothing to provision yet.')
  }

  let totalCreated = 0
  let totalExisting = 0
  let totalFailed = 0
  for (const r of results) {
    if (r.skippedReason) {
      console.log(`⏭️  ${r.businessId}: skipped (${r.skippedReason})`)
      continue
    }
    totalCreated += r.created
    totalExisting += r.existing
    totalFailed += r.failed
    const flag = r.failed > 0 ? '⚠️ ' : '✅'
    console.log(`${flag} ${r.businessId}: ${r.created} created, ${r.existing} existing, ${r.failed} failed (of ${r.attempted})`)
  }

  console.log('\n─────────────────────────────────────────')
  console.log(`Backfill complete: ${totalCreated} created, ${totalExisting} already existed, ${totalFailed} failed across ${results.length} business(es).`)
  console.log('─────────────────────────────────────────')

  await sql.end()
  process.exit(totalFailed > 0 ? 1 : 0)
} catch (err) {
  console.error('Backfill failed:', err instanceof Error ? err.message : err)
  await sql.end()
  process.exit(1)
}
