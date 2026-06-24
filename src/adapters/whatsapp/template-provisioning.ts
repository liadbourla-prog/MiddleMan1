// Per-WABA template provisioning — replicates the template catalog into a business's own WABA.
//
// Templates are owned at the WABA level and each business has its own WABA (Embedded Signup as a
// Tech Provider — ONBOARDING_DESIGN.md §5), so the catalog in `templates.ts` must be CREATED inside
// every business's WABA via the Graph API. This module is that mechanism: author once, replicate
// per business, track idempotently in `wa_template_provisioning`.
//
// Idempotency: the unique (business, template, language) ledger row is upserted each run, and Meta's
// "template already exists" error is treated as success — so re-provisioning a business is safe.
//
// Trigger points: `provisionTemplatesForBusiness` at onboarding completion (once the WABA id is
// captured), and `provisionAllBusinesses` as a backfill (CLI / one-off). Hebrew only for now.

import { eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { businesses, waTemplateProvisioning } from '../../db/schema.js'
import { WA_TEMPLATES, type WaTemplateDef, type TemplateCategory } from './templates.js'

const GRAPH_VERSION = 'v21.0'
type Lang = 'he'

// ── Pure helpers (no I/O — unit-tested) ─────────────────────────────────────────

/** Map our catalog category to Meta's template-category enum. */
export function metaCategory(c: TemplateCategory): 'UTILITY' | 'MARKETING' | 'AUTHENTICATION' {
  return c === 'utility' ? 'UTILITY' : c === 'marketing' ? 'MARKETING' : 'AUTHENTICATION'
}

// Sample values per variable name — Meta requires an `example.body_text` for every body variable so
// reviewers can see a realistic render. Keyed by the `params` labels in templates.ts.
const HE_SAMPLES: Record<string, string> = {
  service: 'תספורת',
  business: 'הסטודיו',
  date: '12/07',
  time: '10:00',
  plan: 'מנוי חודשי',
  hold_minutes: '15',
  proposed_time: 'יום שלישי 14:00',
  current_time: 'יום שני 15:00',
  new_time: 'יום שני 17:00',
  name: 'דנה',
  sender_name: 'יוסי',
  proposed_times: 'יום שלישי 14:00 או 16:00',
  hours: 'א׳-ה׳ 9:00-18:00',
  address: 'הרצל 1, תל אביב',
  promo: '20% הנחה על הביקור הבא',
}

function sampleFor(param: string): string {
  return HE_SAMPLES[param] ?? 'דוגמה'
}

/** Build the Graph API create-template request body for one catalog entry + language. */
export function buildCreateTemplatePayload(def: WaTemplateDef, lang: Lang = 'he'): Record<string, unknown> {
  const text = def.bodies[lang] ?? def.bodies.he
  const component: Record<string, unknown> = { type: 'BODY', text }
  if (def.params.length > 0) {
    component['example'] = { body_text: [def.params.map(sampleFor)] }
  }
  return {
    name: def.name,
    language: lang,
    category: metaCategory(def.category),
    components: [component],
  }
}

/** Meta returns a duplicate-name error when the template already exists in the WABA. Treat as ok. */
export function isAlreadyExistsError(responseText: string): boolean {
  return /already exists/i.test(responseText)
}

type CreateStatus = 'pending' | 'approved' | 'rejected' | 'exists' | 'error'
interface CreateOutcome {
  status: CreateStatus
  metaTemplateId: string | null
  error: string | null
}

/** Normalize Meta's create-template HTTP response into a tracked outcome. Pure given the response. */
export function classifyCreateResponse(ok: boolean, httpStatus: number, body: string): CreateOutcome {
  if (!ok) {
    if (isAlreadyExistsError(body)) return { status: 'exists', metaTemplateId: null, error: null }
    return { status: 'error', metaTemplateId: null, error: `${httpStatus}: ${body}`.slice(0, 500) }
  }
  let parsed: { id?: string; status?: string } = {}
  try { parsed = JSON.parse(body) as { id?: string; status?: string } } catch { /* keep defaults */ }
  const metaStatus = (parsed.status ?? 'PENDING').toUpperCase()
  const status: CreateStatus = metaStatus === 'APPROVED' ? 'approved' : metaStatus === 'REJECTED' ? 'rejected' : 'pending'
  return { status, metaTemplateId: parsed.id ?? null, error: null }
}

// ── I/O ─────────────────────────────────────────────────────────────────────────

async function createOneTemplate(
  wabaId: string,
  accessToken: string,
  def: WaTemplateDef,
  lang: Lang,
): Promise<CreateOutcome> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCreateTemplatePayload(def, lang)),
    })
    const text = await res.text()
    return classifyCreateResponse(res.ok, res.status, text)
  } catch (err) {
    return { status: 'error', metaTemplateId: null, error: err instanceof Error ? err.message : String(err) }
  }
}

async function upsertProvisioningRow(
  db: Db,
  businessId: string,
  templateName: string,
  lang: Lang,
  outcome: CreateOutcome,
): Promise<void> {
  await db
    .insert(waTemplateProvisioning)
    .values({
      businessId,
      templateName,
      languageCode: lang,
      status: outcome.status,
      metaTemplateId: outcome.metaTemplateId,
      lastError: outcome.error,
    })
    .onConflictDoUpdate({
      target: [waTemplateProvisioning.businessId, waTemplateProvisioning.templateName, waTemplateProvisioning.languageCode],
      set: { status: outcome.status, metaTemplateId: outcome.metaTemplateId, lastError: outcome.error, updatedAt: new Date() },
    })
}

export interface ProvisionResult {
  businessId: string
  attempted: number
  created: number
  existing: number
  failed: number
  skippedReason?: 'no_waba' | 'no_token'
}

/**
 * Create (or confirm) every catalog template in one business's WABA, recording each in the
 * provisioning ledger. Idempotent — safe to re-run. No-ops with a `skippedReason` when the business
 * has no WABA id or access token yet.
 */
export async function provisionTemplatesForBusiness(db: Db, businessId: string, lang: Lang = 'he'): Promise<ProvisionResult> {
  const result: ProvisionResult = { businessId, attempted: 0, created: 0, existing: 0, failed: 0 }

  const [biz] = await db
    .select({ wabaId: businesses.whatsappBusinessAccountId, accessToken: businesses.whatsappAccessToken })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!biz?.wabaId) { result.skippedReason = 'no_waba'; return result }
  if (!biz.accessToken) { result.skippedReason = 'no_token'; return result }

  for (const def of Object.values(WA_TEMPLATES)) {
    result.attempted++
    const outcome = await createOneTemplate(biz.wabaId, biz.accessToken, def, lang)
    await upsertProvisioningRow(db, businessId, def.name, lang, outcome)
    if (outcome.status === 'error' || outcome.status === 'rejected') result.failed++
    else if (outcome.status === 'exists') result.existing++
    else result.created++
  }
  return result
}

/** Backfill: provision every business that has a WABA id. Returns one result per business. */
export async function provisionAllBusinesses(db: Db, lang: Lang = 'he'): Promise<ProvisionResult[]> {
  const rows = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(isNotNull(businesses.whatsappBusinessAccountId))

  const results: ProvisionResult[] = []
  for (const r of rows) results.push(await provisionTemplatesForBusiness(db, r.id, lang))
  return results
}
