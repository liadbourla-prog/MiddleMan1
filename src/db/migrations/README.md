# Database migrations

**One applier, no silent skips.** Every `*.sql` file in this directory is applied by
[`scripts/apply-all-migrations.ts`](../../../scripts/apply-all-migrations.ts) via
`npm run db:apply`. Cloud Build runs exactly this step before building/deploying the image
([`cloudbuild.yaml`](../../../cloudbuild.yaml)). It applies files in filename order, statement
by statement, swallowing `42701`/`42P07`/`42710` ("already exists") so re-runs converge, then
**verifies** a cross-section of tables + the `initiation_log` dedup index and exits non-zero on
any gap.

## Why not `drizzle-kit migrate`?

It was retired. The Drizzle journal (`meta/_journal.json`) froze at `0006`, so `drizzle-kit
migrate` **silently skipped** every hand-authored migration after it (reporting success while
applying nothing), which forced a sprawl of per-feature `apply-*.ts` workaround scripts. The
generic applier replaces all of that and is journal-independent.

The Drizzle journal + snapshots under `meta/` are kept **only** as a baseline so
`npm run db:generate` produces a correct incremental diff when you author a new migration. The
baseline was resynced to the live schema, so `db:generate` reports "No schema changes" until the
next real `schema.ts` edit. **`db:generate` is an authoring aid, never an apply mechanism.**

## Adding a migration

1. Edit [`src/db/schema.ts`](../schema.ts) (authoritative).
2. *(optional)* `npm run db:generate` to get diff SQL as a starting point.
3. Hand-author `NNNN_name.sql` here, **idempotent**: `CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`. Look at a recent file
   (e.g. `0026_initiation_log.sql`) for the house style.
4. If it adds a table (or a load-bearing index), add it to `EXPECTED_TABLES` /
   `EXPECTED_INDEXES` in `scripts/apply-all-migrations.ts` so the deploy verifies it.
5. Re-run `npm run db:generate`; it should report **"No schema changes"** (snapshot back in sync).
6. Sanity-check parsing with no DB: `npx tsx scripts/apply-all-migrations.ts --dry-run`.

## Conventions

- Filenames are zero-padded and ordered: `NNNN_short_snake_case.sql`.
- DDL only, plus naturally-idempotent data fixes (see `0009`'s `UPDATE ... WHERE state = ...`).
  Avoid non-idempotent `INSERT`/`UPDATE`/`DELETE` — the applier re-runs every file.
- No dollar-quoted bodies (the applier splits on `;`).
