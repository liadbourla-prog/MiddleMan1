/**
 * Generic, idempotent, self-verifying migration applier — the single source of truth for
 * getting schema onto a database. Replaces both `drizzle-kit migrate` (whose stale journal
 * SILENTLY SKIPS every hand-authored migration past 0006) and the former per-feature
 * apply-*.ts scripts.
 *
 * It runs EVERY src/db/migrations/*.sql in filename order, statement by statement,
 * swallowing "already exists" errors so re-runs are safe. All our migrations are DDL
 * (CREATE/ALTER ... IF NOT EXISTS) plus one naturally-idempotent UPDATE (0009), so applying
 * the full set repeatedly converges to the same state. It then VERIFIES a cross-section of
 * tables + the load-bearing initiation_log dedup index, exiting non-zero on any gap — so a
 * silent skip becomes a loud failure.
 *
 * Deploy (cloudbuild.yaml) runs this via `npm run db:apply`. Locally:
 *   ./cloud-sql-proxy deepr-490316:europe-west3:deepr-project --port 5433 &
 *   DATABASE_URL="postgres://USER:PASS@127.0.0.1:5433/DBNAME" npm run db:apply
 *
 * Adding a migration is now just: drop a NNNN_name.sql (use IF NOT EXISTS) in
 * src/db/migrations/. No journal edits, no new apply script.
 *
 * `--dry-run` parses + lists the files and statement counts without touching a database.
 */
import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import postgres from 'postgres'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations')

// A cross-section spanning the migration timeline; if the applier silently skipped any
// era, one of these will be missing and the verify step fails loudly.
const EXPECTED_TABLES = [
  'businesses',
  'identities',
  'bookings',
  'reminders',
  'business_api_keys',
  'service_price_tiers',
  'freed_slot_approvals',
  'integrity_findings',
  'meeting_coordinations',
  'reshuffle_campaigns',
  'initiation_log',
  'initiation_approvals',
  'initiation_autonomy',
  'subscriptions',
  'business_payment_credentials',
  'payment_connect_tokens',
  'payment_requests',
  'notification_digest_queue',
]
const EXPECTED_INDEXES = [
  'initiation_log_dedup_idx',
  'initiation_approvals_dedup_idx',
  'business_payment_credentials_webhook_token_idx',
  'payment_requests_txn_idx',
]

// Postgres "already exists" codes — duplicate column / table-or-index / object.
const ALREADY_EXISTS = new Set(['42701', '42P07', '42710'])

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort() // 0000_... < 0001_... < ... < 0026_... lexicographically
}

function statementsOf(file: string): string[] {
  const text = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
  return splitSqlStatements(text)
}

/**
 * Split a SQL script into statements on top-level `;` only — i.e. NOT inside dollar-quoted
 * bodies (`$$ ... $$` / `$tag$ ... $tag$`, as used by `DO $$ ... END $$;` blocks in 0016+),
 * single-quoted string literals, or comments. A naive `;`-split shears a `DO $$ ... ; ... $$`
 * block into fragments and Postgres rejects it as an "unterminated dollar-quoted string"
 * (which is exactly how the whole migrate step was silently dying at 0016). Line (`--`) and
 * block (`/* *​/`) comments are dropped at the top level but preserved verbatim inside bodies.
 */
function splitSqlStatements(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let dollarTag: string | null = null
  let inSingle = false
  let inLineComment = false
  let inBlockComment = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; cur += ch }
      i++; continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2 } else { i++ }
      continue
    }
    if (dollarTag) {
      if (text.startsWith(dollarTag, i)) { cur += dollarTag; i += dollarTag.length; dollarTag = null } else { cur += ch; i++ }
      continue
    }
    if (inSingle) {
      cur += ch
      if (ch === "'") inSingle = false
      i++; continue
    }
    if (ch === '-' && next === '-') { inLineComment = true; i += 2; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue }
    if (ch === "'") { inSingle = true; cur += ch; i++; continue }
    if (ch === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i))
      if (m) { dollarTag = m[0]; cur += dollarTag; i += dollarTag.length; continue }
    }
    if (ch === ';') { const t = cur.trim(); if (t) out.push(t); cur = ''; i++; continue }
    cur += ch; i++
  }
  const tail = cur.trim()
  if (tail) out.push(tail)
  return out
}

async function main() {
  const files = migrationFiles()
  const dryRun = process.argv.includes('--dry-run')

  if (dryRun) {
    let total = 0
    for (const file of files) {
      const n = statementsOf(file).length
      total += n
      console.log(`  ${file}: ${n} statements`)
    }
    console.log(`dry-run OK — ${files.length} files, ${total} statements (no DB touched)`)
    process.exit(0)
  }

  const url = process.env['DATABASE_URL']
  if (!url) {
    console.error('DATABASE_URL is required (point it at the Cloud SQL proxy for prod).')
    process.exit(1)
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    for (const file of files) {
      const statements = statementsOf(file)
      let applied = 0
      let skipped = 0
      for (const stmt of statements) {
        try {
          await sql.unsafe(stmt)
          applied++
        } catch (e: unknown) {
          const code = (e as { code?: string }).code
          if (code && ALREADY_EXISTS.has(code)) {
            skipped++
            continue
          }
          console.error(`FAILED in ${file}: ${(e as Error).message}`)
          throw e
        }
      }
      console.log(`${file}: ${applied} applied, ${skipped} already-present`)
    }

    // Verify tables — the real guarantee against a silent skip.
    const tableRows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${EXPECTED_TABLES})`
    const presentTables = new Set(tableRows.map((r) => r.table_name))
    const missingTables = EXPECTED_TABLES.filter((t) => !presentTables.has(t))
    if (missingTables.length > 0) {
      console.error(`VERIFICATION FAILED — missing tables: ${missingTables.join(', ')}`)
      process.exit(1)
    }
    console.log(`verification OK — ${EXPECTED_TABLES.length} key tables present`)

    // Verify load-bearing indexes (initiation_log dedup is the idempotency guard).
    const idxRows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY(${EXPECTED_INDEXES})`
    const presentIdx = new Set(idxRows.map((r) => r.indexname))
    const missingIdx = EXPECTED_INDEXES.filter((i) => !presentIdx.has(i))
    if (missingIdx.length > 0) {
      console.error(`VERIFICATION FAILED — missing indexes: ${missingIdx.join(', ')}`)
      process.exit(1)
    }
    console.log(`verification OK — indexes present: ${EXPECTED_INDEXES.join(', ')}`)
  } finally {
    await sql.end()
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
