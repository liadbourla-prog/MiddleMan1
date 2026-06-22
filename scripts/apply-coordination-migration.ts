/**
 * Idempotent, self-verifying applier for the meeting coordination migration that the
 * stale Drizzle journal causes `db:migrate` to SILENTLY SKIP (see update-agent.md
 * "Migration verification"). Run this against prod (via the Cloud SQL proxy +
 * DATABASE_URL) during deploy instead of trusting `db:migrate` for this file.
 *
 *   ./cloud-sql-proxy deepr-490316:europe-west3:deepr-project --port 5433 &
 *   DATABASE_URL="postgres://USER:PASS@127.0.0.1:5433/DBNAME" tsx scripts/apply-coordination-migration.ts
 *
 * Every statement is `... IF NOT EXISTS`, so re-running is safe. The script then
 * VERIFIES the expected table exists and exits non-zero if missing — so a silent skip
 * becomes a loud failure.
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import postgres from 'postgres'

const MIGRATIONS = ['0024_meeting_coordination.sql', '0025_coordination_windows_identity.sql']
const EXPECTED_TABLES = ['meeting_coordinations']

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
        try {
          await sql.unsafe(stmt)
        } catch (e: unknown) {
          const code = (e as { code?: string }).code
          if (code === '42701' || code === '42P07' || code === '42710') {
            // already exists — idempotent, skip
            continue
          }
          throw e
        }
      }
      console.log(`applied ${file} (${statements.length} statements)`)
    }

    // Verify — the real guarantee against a silent skip.
    const [{ exists }] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'meeting_coordinations'
      ) AS exists`
    if (!exists) {
      console.error('meeting_coordinations missing')
      process.exit(1)
    }
    console.log('meeting_coordinations present ✓')

    // Verify the round-1 columns exist (the actual guarantee for the fixes deploy).
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'businesses' AND column_name = 'outreach_identity_mode')
          OR (table_name = 'meeting_coordinations' AND column_name = 'allowed_windows'))`
    const haveCols = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`))
    const wantCols = ['businesses.outreach_identity_mode', 'meeting_coordinations.allowed_windows']
    const missingCols = wantCols.filter((c) => !haveCols.has(c))
    if (missingCols.length > 0) {
      console.error(`VERIFICATION FAILED — missing columns: ${missingCols.join(', ')}`)
      process.exit(1)
    }
    console.log(`verification OK — columns present: ${wantCols.join(', ')}`)

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
