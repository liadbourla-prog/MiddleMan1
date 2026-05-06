import { z } from 'zod'
import { GoogleGenAI } from '@google/genai'
import type { SkillContext } from '../../shared/skill-types.js'
import { SiteSchemaZod, type SiteSchema } from './site-schema.js'
import { matchPaletteFromText } from '../../shared/palettes.js'

const ai = new GoogleGenAI({ apiKey: process.env['LLM_API_KEY'] ?? '', apiVersion: 'v1beta' })
const MODEL = 'gemini-2.5-flash'

async function callJson<T>(systemPrompt: string, userMessage: string, schema: z.ZodType<T>): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model: MODEL,
        contents: userMessage,
        config: { systemInstruction: systemPrompt, maxOutputTokens: 4096, temperature: 0, responseMimeType: 'application/json' },
      })
      const text = result.text
      if (!text) continue
      let raw: unknown
      try { raw = JSON.parse(text) } catch { continue }
      const parsed = schema.safeParse(raw)
      if (parsed.success) return parsed.data
    } catch { /* retry */ }
  }
  return null
}

// ── Full site content generation (build flow) ─────────────────────────────────

export async function generateSiteContent(
  ctx: SkillContext,
  workflowId: string,
  styleVariant: 'minimal' | 'bold' | 'professional',
  paletteHint: string,
  requirements: {
    practitionerName: string | null
    practitionerTitle: string | null
    practitionerBio: string | null
    address: string | null
    credentials: string[]
    foundedYear: number | null
    googleBusinessProfileUrl: string | null
    domainPreference: string | null
  },
): Promise<SiteSchema | null> {
  const bk = ctx.businessKnowledge
  const lang = ctx.language
  const isHe = lang === 'he'
  const palette = matchPaletteFromText(paletteHint) || paletteHint

  const servicesList = bk.services.map((s) =>
    `- ${s.name}: ${s.durationMinutes}min, price: ${s.price ?? 'on request'} ${s.currency}${s.narrative ? ', notes: ' + s.narrative : ''}`
  ).join('\n')

  const faqList = bk.faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')

  const system = `You are generating a complete website content JSON for a local business.

CRITICAL CONTENT RULES — strictly enforced:
1. Every "description" field must be 40–60 words, factual, and fully standalone (no pronouns referencing other sections).
2. Every FAQ answer must fully respond to the question without needing any other page context.
3. Service descriptions must answer: what it is, who it's for, what to expect, how long, how much.
4. Business description must answer "what is this business?" in one standalone paragraph.
5. "whoFor" must complete the sentence "Ideal for clients who..."
6. "processSteps" must have 3–5 concrete steps describing the appointment.
7. ALL text must be in ${isHe ? 'Hebrew (עברית)' : 'English'}.
8. "tagline" must be ≤10 words, factual, no marketing fluff.
9. Business title format: "[Business Name] — [Primary Service] in [City]" (≤60 chars total).
10. Generate 8–12 FAQs covering: booking, pricing, services, location, policy.

Generate the complete SiteSchema JSON object matching exactly this TypeScript interface:
{
  business: { name, category, tagline, description, city, address, serviceArea, phone, googleBusinessProfileUrl, openingHours, credentials, foundedYear, practitionerName, practitionerTitle, practitionerBio },
  style: { variant, palette, logoUrl, heroImageUrl },
  services: [{ slug, name, description, durationMinutes, price, priceOnRequest, currency, whoFor, processSteps, contraindications, faqs }],
  faqs: [{ question, answer, topic, serviceSlug }],
  language, generatedAt, workflowId
}

FAQ topic values: "booking" | "pricing" | "services" | "location" | "policy" | "general"
serviceSlug: null unless the FAQ is specifically about one service (use the service's slug)
openingHours format: [{ dayOfWeek: ["Monday"], opens: "09:00", closes: "18:00" }]`

  const user = `Business: ${ctx.business.name}
Category: infer from services
City: ${requirements.address ? requirements.address.split(',').pop()?.trim() : 'Israel'}
Address: ${requirements.address ?? 'not provided'}
Phone (PA WhatsApp): ${ctx.caller.phoneNumber}
Brand voice: ${bk.brandVoice ?? 'friendly and professional'}
Google Business Profile URL: ${requirements.googleBusinessProfileUrl ?? 'null'}
Founded year: ${requirements.foundedYear ?? 'null'}
Practitioner: ${requirements.practitionerName ?? 'null'}
Practitioner title: ${requirements.practitionerTitle ?? 'null'}
Practitioner bio input: ${requirements.practitionerBio ?? 'null'}
Credentials: ${requirements.credentials.join(', ') || 'none'}

Services:
${servicesList}

Existing FAQs from PA knowledge:
${faqList || 'none'}

Cancellation policy: ${Math.round(bk.policies.cancellationCutoffMinutes / 60)}h notice
${bk.cancellationFeeAmount ? `Cancellation fee: ${bk.cancellationFeeAmount} ${bk.cancellationFeeCurrency ?? ''}` : 'No cancellation fee'}

Style variant: ${styleVariant}
Palette: ${palette}

workflowId: ${workflowId}
generatedAt: ${new Date().toISOString()}
language: ${lang}`

  return (await callJson(system, user, SiteSchemaZod)) as unknown as SiteSchema | null
}

// ── Patch (update flow) ───────────────────────────────────────────────────────

export async function patchSiteContent(
  existingSchema: SiteSchema,
  editRequest: string,
  ctx: SkillContext,
): Promise<SiteSchema | null> {
  const isHe = ctx.language === 'he'

  const system = `You are updating a business website content JSON.

Apply ONLY the changes described in the edit request. Preserve all other fields exactly as-is.
Return the COMPLETE updated SiteSchema JSON — same structure, same fields, just with the requested changes applied.

CRITICAL: all content rules still apply to changed fields:
- descriptions: 40–60 words, standalone, factual
- FAQ answers: fully self-contained
- text language: ${isHe ? 'Hebrew (עברית)' : 'English'}
- tagline: ≤10 words

Update the "generatedAt" field to: ${new Date().toISOString()}`

  const user = `Edit request from business manager:
"${editRequest}"

Current site schema:
${JSON.stringify(existingSchema, null, 2)}`

  return (await callJson(system, user, SiteSchemaZod)) as unknown as SiteSchema | null
}

// ── Palette suggestion ────────────────────────────────────────────────────────

const paletteSchema = z.object({ palette: z.string(), reasoning: z.string() })

export async function suggestPalette(colorDescription: string, brandVoice: string | null): Promise<string> {
  const palettes = [
    'slate-green', 'warm-terracotta', 'midnight-blue', 'dusty-rose',
    'sage-forest', 'charcoal-gold', 'ocean-teal', 'lavender-purple',
    'brick-cream', 'deep-olive',
  ]

  const system = `You are selecting a color palette for a business website. Available palettes: ${palettes.join(', ')}.
Choose the best match based on the description and brand voice. Return JSON: { "palette": "name", "reasoning": "one sentence" }`

  const user = `Color preference: "${colorDescription}"\nBrand voice: "${brandVoice ?? 'not specified'}"`

  const result = (await callJson(system, user, paletteSchema)) as unknown as { palette: string; reasoning: string } | null
  return result?.palette ?? matchPaletteFromText(colorDescription)
}
