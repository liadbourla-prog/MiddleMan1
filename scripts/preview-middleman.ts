/**
 * Generates a static HTML preview for MiddleMan — the WhatsApp PA platform —
 * using the website-builder renderer directly (no GCS upload, no server needed).
 *
 * Usage: npx tsx scripts/preview-middleman.ts
 * Output: /tmp/middleman-preview/
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { renderSite } from '../src/routes/build-site/renderer.js'
import { buildLlmsTxt, buildRobotsTxt, buildSitemapXml } from '../src/routes/build-site/aeo-layer.js'
import type { SiteSchema } from '../src/skills/website-builder/site-schema.js'

const SITE_URL = 'https://middleman.app'

const schema: SiteSchema = {
  business: {
    name: 'MiddleMan',
    category: 'WhatsApp Business Automation',
    tagline: 'Your business PA, built for WhatsApp',
    description:
      'MiddleMan gives local businesses a dedicated WhatsApp Personal Assistant that manages bookings, ' +
      'answers customer questions, and runs on autopilot — 24/7. No app, no training. Customers book the ' +
      'way they already communicate: by sending a message.',
    city: 'Tel Aviv',
    address: 'Tel Aviv, Israel',
    serviceArea: ['Tel Aviv', 'Jerusalem', 'Haifa', 'Beer Sheva', 'Nationwide'],
    phone: '+15551946756',
    googleBusinessProfileUrl: null,
    openingHours: [
      { dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Sunday'], opens: '09:00', closes: '18:00' },
    ],
    credentials: [
      'Operates on WhatsApp Business Platform API',
      'Google Calendar integration',
      'Enterprise-grade data security',
    ],
    foundedYear: 2024,
    practitionerName: 'Liad Bourla',
    practitionerTitle: 'Founder & CEO',
    practitionerBio:
      'Liad Bourla is a product engineer and entrepreneur focused on making advanced AI genuinely useful ' +
      'for small business owners. MiddleMan was built to give every local business the kind of operational ' +
      'intelligence that was previously reserved for large enterprises.',
  },
  style: {
    variant: 'professional',
    palette: 'midnight-blue',
    logoUrl: null,
    heroImageUrl: null,
  },
  services: [
    {
      slug: 'whatsapp-pa',
      name: 'WhatsApp PA — Booking & Scheduling',
      description:
        'A fully automated Personal Assistant on WhatsApp that handles appointment bookings, cancellations, ' +
        'and rescheduling for your business. Customers interact in natural language, the PA understands intent, ' +
        'checks your live calendar, and confirms bookings — without any manual input from you.',
      durationMinutes: 0,
      price: null,
      priceOnRequest: true,
      currency: 'ILS',
      whoFor:
        'Ideal for local service businesses — salons, clinics, studios, trainers — who spend too much time ' +
        'managing bookings via WhatsApp manually.',
      processSteps: [
        'We onboard your business in 15 minutes: services, hours, cancellation policy',
        'A dedicated WhatsApp number is provisioned and connected to your Google Calendar',
        'Customers message the PA naturally — it books, confirms, and sends reminders automatically',
        'You manage everything from your existing calendar; the PA handles all customer communication',
      ],
      contraindications: null,
      faqs: [
        {
          question: 'Do my customers need to download anything?',
          answer:
            'No. Customers interact through the regular WhatsApp app they already have on their phone. ' +
            'There is no new app to download, no registration, and no learning curve for them.',
        },
        {
          question: 'Does the PA handle rescheduling and cancellations?',
          answer:
            'Yes. The PA handles booking, rescheduling, and cancellations automatically. It enforces your ' +
            'cancellation policy — minimum notice periods, cancellation fees if applicable — and updates ' +
            'Google Calendar in real time.',
        },
      ],
    },
    {
      slug: 'business-knowledge-setup',
      name: 'Business Knowledge Setup',
      description:
        'A guided conversational workflow that teaches your PA everything it needs to represent your business. ' +
        'Through a WhatsApp conversation, you define your services, policies, FAQs, brand voice, and booking ' +
        'rules. The PA then uses this knowledge to answer customer questions accurately and autonomously.',
      durationMinutes: 0,
      price: null,
      priceOnRequest: true,
      currency: 'ILS',
      whoFor:
        'Ideal for business managers who want their PA to answer common customer questions, handle edge cases, ' +
        'and represent the brand consistently without manual supervision.',
      processSteps: [
        'A setup conversation via WhatsApp guides you through each knowledge area: services, prices, policies',
        'You provide FAQs, brand voice descriptors, and booking edge cases in plain language',
        'The system stores and validates your knowledge against AEO standards',
        'The PA immediately begins using the knowledge to answer live customer questions',
      ],
      contraindications: null,
      faqs: [
        {
          question: 'How long does the business knowledge setup take?',
          answer:
            'The guided setup typically takes 20–40 minutes over WhatsApp, spread across however many sessions ' +
            'you prefer. You can pause and resume at any time. Most businesses complete it in one or two sittings.',
        },
      ],
    },
    {
      slug: 'website-builder',
      name: 'AI-Generated Business Website',
      description:
        "A 4–5 page business website generated entirely from your PA's knowledge, optimised for AI answer " +
        'engines (ChatGPT, Gemini, Perplexity) and local SEO. Built through a WhatsApp conversation: you ' +
        'describe your preferences, the PA generates factual content, and the site is live within minutes.',
      durationMinutes: 0,
      price: null,
      priceOnRequest: true,
      currency: 'ILS',
      whoFor:
        'Ideal for local service businesses that need a professional web presence without the cost or complexity ' +
        'of a traditional web agency — and who want AI systems to cite and recommend their business.',
      processSteps: [
        'A WhatsApp conversation gathers your style preferences, colours, and any missing business details',
        'The AI generates a complete, factual SiteSchema: all page content, FAQs, service descriptions',
        'An AEO pass validates content for AI citation quality and auto-fixes structural issues',
        'A preview URL is delivered to your WhatsApp for review and approval',
        'On approval, the site goes live with full JSON-LD schemas, llms.txt, and sitemap',
      ],
      contraindications: null,
      faqs: [
        {
          question: 'Will my website appear in ChatGPT or Perplexity results?',
          answer:
            'The website is built to maximise AI answer-engine visibility: every page includes structured JSON-LD ' +
            'schemas, a machine-readable llms.txt, and factual standalone answer blocks that AI systems can cite ' +
            'directly. This significantly improves the chance of being cited in AI-generated answers.',
        },
      ],
    },
  ],
  faqs: [
    {
      question: 'How quickly can I get MiddleMan set up for my business?',
      answer:
        'Onboarding takes about 15 minutes. You provide your services, opening hours, and cancellation policy via ' +
        'WhatsApp, and your PA is live the same day. No technical setup required on your end — we handle the ' +
        'WhatsApp API connection and Google Calendar integration.',
      topic: 'booking',
      serviceSlug: null,
    },
    {
      question: 'What does MiddleMan cost?',
      answer:
        'Pricing is on request and tailored to business size and message volume. Contact us via WhatsApp to get ' +
        'a quote. There is no per-booking fee — you pay a flat monthly rate that covers unlimited customer interactions.',
      topic: 'pricing',
      serviceSlug: null,
    },
    {
      question: 'Does MiddleMan work with my existing Google Calendar?',
      answer:
        'Yes. MiddleMan connects directly to your Google Calendar via OAuth. All bookings, cancellations, and ' +
        'reschedules appear as calendar events in real time. You can continue using your calendar exactly as before.',
      topic: 'services',
      serviceSlug: null,
    },
    {
      question: 'What languages does the PA support?',
      answer:
        "The PA supports Hebrew and English and automatically detects the customer's language based on their " +
        'messages. Bilingual businesses can serve both Hebrew and English-speaking customers without any ' +
        'configuration — the PA switches language per conversation.',
      topic: 'services',
      serviceSlug: null,
    },
    {
      question: 'Can I customise how the PA responds to customers?',
      answer:
        'Yes. During the Business Knowledge Setup, you define your brand voice — formal, friendly, direct, warm — ' +
        'and the PA adapts its tone accordingly. You also define FAQs, service descriptions, and booking policies ' +
        'that the PA uses verbatim when answering questions.',
      topic: 'services',
      serviceSlug: null,
    },
    {
      question: 'What happens when a customer asks something the PA cannot answer?',
      answer:
        'The PA is designed to recognise its own knowledge boundaries. When a question falls outside its ' +
        'configured knowledge, it gracefully tells the customer that a team member will follow up, and ' +
        'notifies you via WhatsApp so no customer query is left unanswered.',
      topic: 'general',
      serviceSlug: null,
    },
    {
      question: 'Is my customer data secure?',
      answer:
        'All data is processed through the official WhatsApp Business Platform API and stored in encrypted ' +
        'databases on Google Cloud Platform. Customer phone numbers are stored only as needed for booking ' +
        'management and are never shared with third parties.',
      topic: 'policy',
      serviceSlug: null,
    },
    {
      question: 'Where is MiddleMan available?',
      answer:
        'MiddleMan is currently available for businesses in Israel and is expanding internationally. The PA ' +
        'works wherever WhatsApp is available, making it suitable for businesses serving customers across ' +
        'multiple cities or countries.',
      topic: 'location',
      serviceSlug: null,
    },
  ],
  language: 'en',
  generatedAt: new Date().toISOString(),
  workflowId: 'preview-middleman-demo',
}

// ── Render ────────────────────────────────────────────────────────────────────

const outDir = '/tmp/middleman-preview'
const rendered = renderSite(schema, SITE_URL)

const pages: Array<{ path: string; url: string }> = [
  { path: 'index.html', url: `${SITE_URL}/` },
  { path: 'services/index.html', url: `${SITE_URL}/services/` },
  { path: 'faq/index.html', url: `${SITE_URL}/faq/` },
  { path: 'contact/index.html', url: `${SITE_URL}/contact/` },
  { path: 'about/index.html', url: `${SITE_URL}/about/` },
]

mkdirSync(`${outDir}/services`, { recursive: true })
mkdirSync(`${outDir}/faq`, { recursive: true })
mkdirSync(`${outDir}/contact`, { recursive: true })
mkdirSync(`${outDir}/about`, { recursive: true })

for (const [filename, html] of Object.entries(rendered)) {
  if (html) writeFileSync(join(outDir, filename), html)
}

// AEO files
writeFileSync(join(outDir, 'llms.txt'), buildLlmsTxt(schema))
writeFileSync(join(outDir, 'robots.txt'), buildRobotsTxt(SITE_URL))
writeFileSync(
  join(outDir, 'sitemap.xml'),
  buildSitemapXml(pages.map((p) => ({ url: p.url, lastmod: schema.generatedAt })))
)

console.log(`\n✅ Preview rendered to: ${outDir}`)
console.log(`\nPages generated:`)
for (const p of pages) console.log(`  • ${p.path}`)
console.log(`\nAEO files:`)
console.log(`  • llms.txt`)
console.log(`  • robots.txt`)
console.log(`  • sitemap.xml`)
console.log(`\nOpen: file://${outDir}/index.html\n`)
