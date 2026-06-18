/**
 * Idempotent, self-verifying applier for the CRM migrations that the stale Drizzle
 * journal causes `db:migrate` to SILENTLY SKIP (see update-agent.md "Migration
 * verification"). Run this against prod (via the Cloud SQL proxy + DATABASE_URL)
 * during deploy instead of trusting `db:migrate` for these files.
 *
 *   ./cloud-sql-proxy deepr-490316:europe-west3:deepr-project --port 5433 &
 *   DATABASE_URL="postgres://USER:PASS@127.0.0.1:5433/DBNAME" tsx scripts/apply-crm-migrations.ts
 *
 * Every statement is `... IF NOT EXISTS`, so re-running is safe. The script then
 * VERIFIES the expected tables exist and exits non-zero if any are missing — so a
 * silent skip becomes a loud failure.
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import postgres from 'postgres'

const MIGRATIONS = ['0019_crm_tier_a_pricing.sql', '0020_business_api_keys.sql']
const EXPECTED_TABLES = ['service_price_tiers', 'business_api_keys']

async function main() {
  const url = process.env['DATABASE_URL']
  if (!url) {
    console.error('DATABASE_URL is required (point it at the Cloud SQL proxy for prod).')
    process.exit(1)
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    for (const file of MIGRATIONS) {
      const text = readFileSync(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8')
      // Strip line comments FIRST (they may contain semicolons), THEN split into
      // statements. These migrations are plain CREATE TABLE/INDEX with no
      // dollar-quoted bodies, so a ';' split is correct once comments are gone.
      const statements = text
        .replace(/--.*$/gm, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      for (const stmt of statements) {
        await sql.unsafe(stmt)
      }
      console.log(`applied ${file} (${statements.length} statements)`)
    }

    // Verify — the real guarantee against a silent skip.
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${EXPECTED_TABLES})`
    const present = new Set(rows.map((r) => r.table_name))
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t))
    if (missing.length > 0) {
      console.error(`VERIFICATION FAILED — missing tables: ${missing.join(', ')}`)
      process.exit(1)
    }
    console.log(`verification OK — present: ${EXPECTED_TABLES.join(', ')}`)
  } finally {
    await sql.end()
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
