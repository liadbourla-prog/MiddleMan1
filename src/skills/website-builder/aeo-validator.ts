import { z } from 'zod'
import { GoogleGenAI } from '@google/genai'
import type { SiteSchema } from './site-schema.js'

const ai = new GoogleGenAI({ apiKey: process.env['LLM_API_KEY'] ?? '', apiVersion: 'v1beta' })
const MODEL = 'gemini-2.5-flash'

export interface AeoCheckResult {
  passed: boolean
  code: string
  message: string
  autoFixed: boolean
}

export interface AeoReport {
  checks: AeoCheckResult[]
  passedCount: number
  totalCount: number
  advisoryScore: number | null   // 1–5 from LLM pass, null if skipped
  advisoryNotes: string[]
}

// ── Deterministic checks + auto-fixes ────────────────────────────────────────

export function runAeoChecks(schema: SiteSchema): { schema: SiteSchema; report: AeoReport } {
  const checks: AeoCheckResult[] = []
  let patched = { ...schema, business: { ...schema.business }, style: { ...schema.style } }

  function check(code: string, passed: boolean, message: string, autoFixed = false): void {
    checks.push({ passed: passed || autoFixed, code, message, autoFixed })
  }

  // Title length — derive from business name + city
  const derivedTitle = `${schema.business.name} — ${schema.business.category} in ${schema.business.city}`
  if (derivedTitle.length > 60) {
    const truncated = derivedTitle.slice(0, 59).replace(/\s+\S*$/, '') + '…'
    check('TITLE_LENGTH', false, `Title too long (${derivedTitle.length} chars): "${truncated}"`, true)
  } else {
    check('TITLE_LENGTH', true, `Title within 60 chars (${derivedTitle.length})`)
  }

  // Business description word count
  const descWords = schema.business.description.split(/\s+/).length
  if (descWords < 30 || descWords > 100) {
    check('DESCRIPTION_LENGTH', false, `Business description is ${descWords} words (target: 40–80 words)`)
  } else {
    check('DESCRIPTION_LENGTH', true, `Business description: ${descWords} words`)
  }

  // FAQ count (including service-level FAQs)
  const totalFaqs = schema.faqs.length + schema.services.reduce((n, s) => n + s.faqs.length, 0)
  if (totalFaqs < 5) {
    check('FAQ_COUNT', false, `Only ${totalFaqs} FAQs — minimum 5 required`)
  } else {
    check('FAQ_COUNT', true, `${totalFaqs} FAQs`)
  }

  // FAQ answer lengths
  const shortFaqs = schema.faqs.filter((f) => f.answer.split(/\s+/).length < 15)
  if (shortFaqs.length > 0) {
    check('FAQ_ANSWER_LENGTH', false, `${shortFaqs.length} FAQ answer(s) too short (<15 words): "${shortFaqs[0]?.question}"`)
  } else {
    check('FAQ_ANSWER_LENGTH', true, 'All FAQ answers meet minimum length')
  }

  // Service descriptions
  const shortServices = schema.services.filter((s) => s.description.split(/\s+/).length < 25)
  if (shortServices.length > 0) {
    check('SERVICE_DESCRIPTION', false, `${shortServices.length} service description(s) too short: "${shortServices[0]?.name}"`)
  } else {
    check('SERVICE_DESCRIPTION', true, 'All service descriptions meet minimum length')
  }

  // processSteps per service
  const missingSteps = schema.services.filter((s) => s.processSteps.length < 3)
  if (missingSteps.length > 0) {
    check('PROCESS_STEPS', false, `${missingSteps.length} service(s) missing process steps: "${missingSteps[0]?.name}"`)
  } else {
    check('PROCESS_STEPS', true, 'All services have process steps')
  }

  // Opening hours
  if (schema.business.openingHours.length === 0) {
    check('OPENING_HOURS', false, 'No opening hours defined — AI systems cannot answer "when are you open?"')
  } else {
    check('OPENING_HOURS', true, `${schema.business.openingHours.length} opening hour block(s)`)
  }

  // Phone
  if (!schema.business.phone || schema.business.phone.length < 5) {
    check('PHONE', false, 'Phone number missing — critical for WhatsApp CTA and LocalBusiness schema')
  } else {
    check('PHONE', true, 'Phone number present')
  }

  // Service area
  if (schema.business.serviceArea.length === 0) {
    // Auto-fix: add city
    patched = {
      ...patched,
      business: { ...patched.business, serviceArea: [schema.business.city] },
    }
    check('SERVICE_AREA', false, `No service area — auto-added city: ${schema.business.city}`, true)
  } else {
    check('SERVICE_AREA', true, `Service area: ${schema.business.serviceArea.join(', ')}`)
  }

  // tagline length
  const taglineWords = schema.business.tagline.split(/\s+/).length
  if (taglineWords > 12) {
    check('TAGLINE_LENGTH', false, `Tagline too long (${taglineWords} words, target ≤10)`)
  } else {
    check('TAGLINE_LENGTH', true, `Tagline: ${taglineWords} words`)
  }

  const passedCount = checks.filter((c) => c.passed).length

  return {
    schema: patched,
    report: {
      checks,
      passedCount,
      totalCount: checks.length,
      advisoryScore: null,
      advisoryNotes: [],
    },
  }
}

// ── LLM advisory pass ─────────────────────────────────────────────────────────

const advisorySchema = z.object({
  score: z.number().min(1).max(5),
  notes: z.array(z.string()).max(5),
})

export async function runAdvisoryPass(schema: SiteSchema): Promise<{ score: number; notes: string[] } | null> {
  // Sample key answer blocks
  const samples = [
    { q: 'What does this business do?', a: schema.business.description },
    ...schema.faqs.slice(0, 3).map((f) => ({ q: f.question, a: f.answer })),
    ...schema.services.slice(0, 2).map((s) => ({ q: `What is ${s.name}?`, a: s.description })),
  ]

  const system = `You are evaluating website content for AI answer-engine readability.

For each Q&A pair, assess: does the answer fully respond to the question as a standalone passage, without needing context from the rest of the page?

Score the overall content 1–5:
5 = Every answer is a complete, accurate, citable response
4 = Most answers are standalone; minor gaps
3 = Some answers require page context to make sense
2 = Multiple answers are incomplete or generic
1 = Content is not suitable for AI citation

Return JSON: { "score": number, "notes": ["brief note about what to improve", ...] (max 5 notes) }`

  const user = samples.map((s) => `Q: ${s.q}\nA: ${s.a}`).join('\n\n---\n\n')

  return (await (async () => {
    try {
      const result = await ai.models.generateContent({
        model: MODEL,
        contents: user,
        config: { systemInstruction: system, maxOutputTokens: 512, temperature: 0, responseMimeType: 'application/json' },
      })
      const text = result.text
      if (!text) return null
      let raw: unknown
      try { raw = JSON.parse(text) } catch { return null }
      const parsed = advisorySchema.safeParse(raw)
      if (parsed.success) return parsed.data as unknown as { score: number; notes: string[] }
    } catch { /* ignore */ }
    return null
  })()) as { score: number; notes: string[] } | null
}

// ── Combined AEO pass ─────────────────────────────────────────────────────────

export async function runFullAeoPass(schema: SiteSchema): Promise<{ schema: SiteSchema; report: AeoReport }> {
  const { schema: patchedSchema, report } = runAeoChecks(schema)
  const advisory = await runAdvisoryPass(patchedSchema)

  return {
    schema: patchedSchema,
    report: {
      ...report,
      advisoryScore: advisory?.score ?? null,
      advisoryNotes: advisory?.notes ?? [],
    },
  }
}

// ── Report summary for WhatsApp ───────────────────────────────────────────────

export function formatAeoSummary(report: AeoReport, lang: 'he' | 'en'): string {
  const isHe = lang === 'he'
  const scoreStr = report.advisoryScore !== null
    ? ` · ${isHe ? 'ציון' : 'Score'}: ${report.advisoryScore}/5`
    : ''

  const lines: string[] = [
    `${isHe ? 'AEO' : 'AEO'}: ${report.passedCount}/${report.totalCount} ${isHe ? 'בדיקות עברו' : 'checks passed'}${scoreStr}`,
  ]

  const failed = report.checks.filter((c) => !c.passed && !c.autoFixed).slice(0, 3)
  for (const f of failed) {
    lines.push(`• ${f.message}`)
  }

  const autoFixed = report.checks.filter((c) => c.autoFixed)
  if (autoFixed.length > 0) {
    lines.push(isHe ? `✅ תוקן אוטומטית: ${autoFixed.map((c) => c.code).join(', ')}` : `✅ Auto-fixed: ${autoFixed.map((c) => c.code).join(', ')}`)
  }

  if (report.advisoryNotes.length > 0) {
    lines.push(isHe ? `💡 ${report.advisoryNotes[0]}` : `💡 ${report.advisoryNotes[0]}`)
  }

  return lines.join('\n')
}
