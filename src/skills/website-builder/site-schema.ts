import { z } from 'zod'

// ── Sub-types ─────────────────────────────────────────────────────────────────

export interface OpeningHoursBlock {
  dayOfWeek: string[]
  opens: string   // 'HH:MM'
  closes: string  // 'HH:MM'
}

export interface ServiceEntry {
  slug: string
  name: string
  description: string        // 40–60 words, standalone, factual
  durationMinutes: number
  price: number | null
  priceOnRequest: boolean
  currency: string
  whoFor: string             // "Ideal for clients who..."
  processSteps: string[]     // 3–5 steps, rendered as HowTo schema
  contraindications: string | null
  faqs: Array<{ question: string; answer: string }>
}

export interface FaqEntry {
  question: string
  answer: string             // 40–60 words, standalone
  topic: 'booking' | 'pricing' | 'services' | 'location' | 'policy' | 'general'
  serviceSlug: string | null
}

export interface SiteSchema {
  business: {
    name: string
    category: string
    tagline: string            // ≤10 words
    description: string        // 40–60 words standalone
    city: string
    address: string | null
    serviceArea: string[]
    phone: string              // E.164 — PA WhatsApp number
    googleBusinessProfileUrl: string | null
    openingHours: OpeningHoursBlock[]
    credentials: string[]
    foundedYear: number | null
    practitionerName: string | null
    practitionerTitle: string | null
    practitionerBio: string | null   // 40–60 words
  }
  style: {
    variant: 'minimal' | 'bold' | 'professional'
    palette: string
    logoUrl: string | null
    heroImageUrl: string | null
  }
  services: ServiceEntry[]
  faqs: FaqEntry[]
  language: 'he' | 'en'
  generatedAt: string          // ISO 8601
  workflowId: string
}

// ── Zod schema ────────────────────────────────────────────────────────────────

const openingHoursZod = z.object({
  dayOfWeek: z.array(z.string()).min(1),
  opens: z.string(),
  closes: z.string(),
})

const serviceEntryZod = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().min(10),
  durationMinutes: z.number().int().positive(),
  price: z.number().nullable(),
  priceOnRequest: z.boolean(),
  currency: z.string(),
  whoFor: z.string(),
  processSteps: z.array(z.string()),
  // The model often returns contraindications as a LIST. Accept both and normalize
  // to the single string the schema promises (joined), so a harmless shape
  // difference never fails the whole site generation.
  contraindications: z.preprocess(
    (v) => (Array.isArray(v) ? (v.length ? v.join('; ') : null) : v),
    z.string().nullable(),
  ),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })),
})

const faqEntryZod = z.object({
  question: z.string().min(5),
  answer: z.string().min(10),
  topic: z.enum(['booking', 'pricing', 'services', 'location', 'policy', 'general']),
  serviceSlug: z.string().nullable(),
})

// Output is SiteSchema; input is `unknown` because some fields use z.preprocess to
// tolerate the model's shape variations (string vs array) before validating.
export const SiteSchemaZod: z.ZodType<SiteSchema, z.ZodTypeDef, unknown> = z.object({
  business: z.object({
    name: z.string().min(1),
    category: z.string().min(1),
    tagline: z.string().min(2),
    description: z.string().min(20),
    city: z.string().min(1),
    address: z.string().nullable(),
    // The model often returns serviceArea as a single string ("Tel Aviv area")
    // instead of an array. Accept both and normalize to the array the schema wants.
    serviceArea: z.preprocess(
      (v) => (typeof v === 'string' ? (v.trim() ? [v] : []) : v),
      z.array(z.string()),
    ),
    phone: z.string().min(5),
    googleBusinessProfileUrl: z.string().nullable(),
    openingHours: z.array(openingHoursZod),
    credentials: z.array(z.string()),
    foundedYear: z.number().int().nullable(),
    practitionerName: z.string().nullable(),
    practitionerTitle: z.string().nullable(),
    practitionerBio: z.string().nullable(),
  }),
  style: z.object({
    variant: z.enum(['minimal', 'bold', 'professional']),
    palette: z.string(),
    logoUrl: z.string().nullable(),
    heroImageUrl: z.string().nullable(),
  }),
  services: z.array(serviceEntryZod).min(1),
  faqs: z.array(faqEntryZod).min(1),
  language: z.enum(['he', 'en']),
  generatedAt: z.string(),
  workflowId: z.string(),
})
