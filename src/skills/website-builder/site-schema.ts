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

// ── Add-on types ──────────────────────────────────────────────────────────────

export type AddonKey = 'bookingWidget' | 'paymentOptions' | 'memberships' | 'products' | 'team' | 'testimonials' | 'gallery'

export interface BookingWidgetAddon {
  serviceIds: string[]        // service slugs, or ['all'] for all services
  lookAheadDays: number
  showPrices: boolean
  liveApiPath: string | null  // null until GATE-2 resolved; widget falls back to WhatsApp CTA
}

export interface PaymentAddon {
  methods: string[]
  links: Record<string, string>
  notes: string | null
}

export interface MembershipTier {
  name: string
  price: string      // string to handle "200/month", "2400/year", etc.
  period: string     // 'monthly' | 'yearly' | 'one-time' | etc.
  features: string[]
}

export interface MembershipsAddon {
  tiers: MembershipTier[]
}

export interface ProductItem {
  name: string
  description: string
  price: string
}

export interface ProductsAddon {
  items: ProductItem[]
}

export interface TeamMember {
  name: string
  title: string
  bio: string
}

export interface TeamAddon {
  members: TeamMember[]
}

export interface TestimonialEntry {
  authorName: string
  quote: string
  serviceName: string | null
  rating: number | null   // 1–5
}

export interface TestimonialsAddon {
  reviews: TestimonialEntry[]
}

export interface GallerySection {
  title: string
  description: string | null
}

export interface GalleryAddon {
  sections: GallerySection[]
}

export interface SiteAddons {
  bookingWidget?: BookingWidgetAddon
  paymentOptions?: PaymentAddon
  memberships?: MembershipsAddon
  products?: ProductsAddon
  team?: TeamAddon
  testimonials?: TestimonialsAddon
  gallery?: GalleryAddon
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
  addons?: SiteAddons
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
  contraindications: z.string().nullable(),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })),
})

const faqEntryZod = z.object({
  question: z.string().min(5),
  answer: z.string().min(10),
  topic: z.enum(['booking', 'pricing', 'services', 'location', 'policy', 'general']),
  serviceSlug: z.string().nullable(),
})

const bookingWidgetAddonZod = z.object({
  serviceIds: z.array(z.string()),
  lookAheadDays: z.number().int().positive(),
  showPrices: z.boolean(),
  liveApiPath: z.string().nullable(),
})

const paymentAddonZod = z.object({
  methods: z.array(z.string()).min(1),
  links: z.record(z.string()),
  notes: z.string().nullable(),
})

const membershipTierZod = z.object({
  name: z.string().min(1),
  price: z.string().min(1),
  period: z.string().min(1),
  features: z.array(z.string()),
})

const membershipsAddonZod = z.object({
  tiers: z.array(membershipTierZod).min(1),
})

const productItemZod = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  price: z.string().min(1),
})

const productsAddonZod = z.object({
  items: z.array(productItemZod).min(1),
})

const teamMemberZod = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  bio: z.string().min(5),
})

const teamAddonZod = z.object({
  members: z.array(teamMemberZod).min(1),
})

const testimonialEntryZod = z.object({
  authorName: z.string().min(1),
  quote: z.string().min(5),
  serviceName: z.string().nullable(),
  rating: z.number().int().min(1).max(5).nullable(),
})

const testimonialsAddonZod = z.object({
  reviews: z.array(testimonialEntryZod).min(1),
})

const gallerySectionZod = z.object({
  title: z.string().min(1),
  description: z.string().nullable(),
})

const galleryAddonZod = z.object({
  sections: z.array(gallerySectionZod).min(1),
})

const siteAddonsZod = z.object({
  bookingWidget: bookingWidgetAddonZod.optional(),
  paymentOptions: paymentAddonZod.optional(),
  memberships: membershipsAddonZod.optional(),
  products: productsAddonZod.optional(),
  team: teamAddonZod.optional(),
  testimonials: testimonialsAddonZod.optional(),
  gallery: galleryAddonZod.optional(),
})

export { siteAddonsZod }

export const SiteSchemaZod: z.ZodType<SiteSchema> = z.object({
  business: z.object({
    name: z.string().min(1),
    category: z.string().min(1),
    tagline: z.string().min(2),
    description: z.string().min(20),
    city: z.string().min(1),
    address: z.string().nullable(),
    serviceArea: z.array(z.string()),
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
  addons: siteAddonsZod.optional(),
})
