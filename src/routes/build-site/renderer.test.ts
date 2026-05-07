// src/routes/build-site/renderer.test.ts
import { describe, it, expect } from 'vitest'
import { renderSite } from './renderer.js'
import type { SiteSchema } from '../../skills/website-builder/site-schema.js'

// ── Shared fixture ──────────────────────────────────────────────────────────

function makeSchema(variant: 'minimal' | 'bold' | 'professional'): SiteSchema {
  return {
    business: {
      name: 'Test Salon',
      category: 'Hair Salon',
      tagline: 'Quality cuts in Tel Aviv',
      description:
        'Test Salon is a professional hair salon in Tel Aviv offering cuts, colouring, and styling for all hair types. We specialise in modern techniques and provide a relaxed, welcoming environment.',
      city: 'Tel Aviv',
      address: '1 Dizengoff St',
      serviceArea: ['Tel Aviv', 'Ramat Gan'],
      phone: '+972501234567',
      googleBusinessProfileUrl: null,
      openingHours: [
        { dayOfWeek: ['Monday', 'Tuesday', 'Wednesday'], opens: '09:00', closes: '18:00' },
        { dayOfWeek: ['Saturday'], opens: '10:00', closes: '16:00' },
      ],
      credentials: ['Licensed by the Israel Board of Cosmetology', '10 years experience'],
      foundedYear: 2014,
      practitionerName: 'Dana Cohen',
      practitionerTitle: 'Master Stylist',
      practitionerBio:
        'Dana Cohen is a master stylist with over 10 years of experience in Tel Aviv. She specialises in colour correction and textured hair, and has trained at leading academies in London and New York.',
    },
    style: { variant, palette: 'midnight-blue', logoUrl: null, heroImageUrl: null },
    services: [
      {
        slug: 'haircut',
        name: 'Haircut & Style',
        description:
          'A full haircut and style session tailored to your face shape and lifestyle. Includes consultation, wash, cut, and blow-dry by our experienced stylists.',
        durationMinutes: 60,
        price: 200,
        priceOnRequest: false,
        currency: 'ILS',
        whoFor: 'Anyone wanting a fresh, professional cut',
        processSteps: ['Consultation', 'Wash', 'Cut', 'Style', 'Finish'],
        contraindications: null,
        faqs: [{ question: 'Do I need to book in advance?', answer: 'Yes, we recommend booking at least 24 hours in advance to secure your preferred time slot.' }],
      },
      {
        slug: 'colour',
        name: 'Hair Colouring',
        description:
          'Full hair colouring service using professional-grade products. Includes consultation to choose the right shade, application, and blow-dry styling.',
        durationMinutes: 120,
        price: null,
        priceOnRequest: true,
        currency: 'ILS',
        whoFor: 'Clients looking to change or refresh their hair colour',
        processSteps: ['Colour consultation', 'Strand test', 'Application', 'Processing', 'Rinse & style'],
        contraindications: 'Not suitable if you have had a chemical treatment in the last 2 weeks.',
        faqs: [],
      },
    ],
    faqs: [
      {
        question: 'Where is Test Salon located?',
        answer: 'Test Salon is located at 1 Dizengoff St, Tel Aviv, easily reachable by bus and train.',
        topic: 'location',
        serviceSlug: null,
      },
      {
        question: 'How do I book an appointment?',
        answer:
          'Send us a WhatsApp message and our assistant will confirm your booking within minutes. No app needed.',
        topic: 'booking',
        serviceSlug: null,
      },
      {
        question: 'What are your opening hours?',
        answer: 'We are open Monday to Wednesday 09:00–18:00 and Saturday 10:00–16:00.',
        topic: 'location',
        serviceSlug: null,
      },
      {
        question: 'What payment methods do you accept?',
        answer: 'We accept cash, credit cards, and bank transfers. Payment is taken at the end of each session.',
        topic: 'pricing',
        serviceSlug: null,
      },
      {
        question: 'Do you offer a cancellation policy?',
        answer:
          'Yes. Please cancel at least 24 hours before your appointment. Late cancellations may incur a fee.',
        topic: 'policy',
        serviceSlug: null,
      },
    ],
    language: 'en',
    generatedAt: '2026-05-07T12:00:00Z',
    workflowId: 'wf-test-001',
  }
}

const SITE_URL = 'https://test.example.com'

// ── Helpers ─────────────────────────────────────────────────────────────────

function homepage(variant: 'minimal' | 'bold' | 'professional' = 'minimal'): string {
  return renderSite(makeSchema(variant), SITE_URL)['index.html']
}
function servicesPage(variant: 'minimal' | 'bold' | 'professional' = 'minimal'): string {
  return renderSite(makeSchema(variant), SITE_URL)['services/index.html']
}
function faqPage(): string {
  return renderSite(makeSchema('minimal'), SITE_URL)['faq/index.html']
}
function contactPage(): string {
  return renderSite(makeSchema('minimal'), SITE_URL)['contact/index.html']
}
function aboutPage(): string {
  const result = renderSite(makeSchema('minimal'), SITE_URL)
  return result['about/index.html'] ?? ''
}

// ── AEO preservation (must never break) ──────────────────────────────────────

describe('AEO preservation', () => {
  it('homepage has .answer-block on hero lead', () => {
    expect(homepage()).toContain('class="lead answer-block"')
  })

  it('homepage FAQ items have .faq-item, .faq-question, .faq-answer', () => {
    const html = homepage()
    expect(html).toContain('class="faq-item"')
    expect(html).toContain('class="faq-question"')
    expect(html).toContain('class="faq-answer')
  })

  it('FAQ page uses <h3 class="faq-question">', () => {
    expect(faqPage()).toContain('<h3 class="faq-question"')
  })

  it('footer contains <address> block', () => {
    expect(homepage()).toContain('<address>')
  })

  it('sections have aria-labelledby attributes', () => {
    expect(homepage()).toContain('aria-labelledby=')
  })

  it('all pages have <h1>', () => {
    expect(homepage()).toContain('<h1>')
    expect(servicesPage()).toContain('<h1>')
    expect(faqPage()).toContain('<h1>')
    expect(contactPage()).toContain('<h1>')
    expect(aboutPage()).toContain('<h1>')
  })

  it('hero lead still wraps the business description in .answer-block', () => {
    const html = homepage()
    // The business description must appear in an answer-block inside the hero
    expect(html).toMatch(/class="lead answer-block"[^>]*>[^<]*Test Salon is a professional/)
  })
})

// ── Nav aria-current ──────────────────────────────────────────────────────────

describe('nav aria-current', () => {
  it('homepage nav marks / as current', () => {
    expect(homepage()).toContain('aria-current="page"')
    // Only one link is marked current
    const matches = homepage().match(/aria-current="page"/g) ?? []
    // Header nav + footer nav = 2 occurrences for current page
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it('services page marks /services/ as current', () => {
    expect(servicesPage()).toContain('aria-current="page"')
  })

  it('homepage nav does not mark /services/ as current', () => {
    // services link should NOT have aria-current on homepage
    const html = homepage()
    // Ensure the services link lacks aria-current
    expect(html).not.toMatch(/href="[^"]*\/services\/"[^>]*aria-current="page"/)
    expect(html).not.toMatch(/aria-current="page"[^>]*href="[^"]*\/services\/"/)
  })
})

// ── Split hero ─────────────────────────────────────────────────────────────────

describe('split hero', () => {
  it('homepage has .hero-inner', () => {
    expect(homepage()).toContain('class="hero-inner"')
  })

  it('homepage has .hero-text panel', () => {
    expect(homepage()).toContain('class="hero-text"')
  })

  it('homepage has .hero-panel with aria-hidden="true"', () => {
    expect(homepage()).toContain('class="hero-panel"')
    expect(homepage()).toContain('aria-hidden="true"')
  })

  it('hero-panel contains service names as highlights', () => {
    const html = homepage()
    // Should contain at least one hero-service-card
    expect(html).toContain('class="hero-service-card"')
  })

  it('hero has .hero-eyebrow with category and city', () => {
    const html = homepage()
    expect(html).toContain('class="hero-eyebrow"')
    expect(html).toContain('Hair Salon')
    expect(html).toContain('Tel Aviv')
  })
})

// ── Section classes ────────────────────────────────────────────────────────────

describe('section classes', () => {
  it('homepage has .section-dark on CTA section', () => {
    expect(homepage()).toContain('section-dark')
  })

  it('homepage has .section-surface on services section', () => {
    expect(homepage()).toContain('section-surface')
  })

  it('FAQ page has .section-dark on CTA section', () => {
    expect(faqPage()).toContain('section-dark')
  })
})

// ── Variant-driven service cards ───────────────────────────────────────────────

describe('variant service cards', () => {
  it('bold variant renders .services-list with .service-feature', () => {
    const html = homepage('bold')
    expect(html).toContain('class="services-list"')
    expect(html).toContain('class="service-feature')
  })

  it('minimal variant renders .services-grid with .service-card', () => {
    const html = homepage('minimal')
    expect(html).toContain('class="services-grid"')
    expect(html).toContain('class="service-card"')
  })

  it('professional variant renders .services-grid with .service-card-pro', () => {
    const html = homepage('professional')
    expect(html).toContain('class="services-grid"')
    expect(html).toContain('class="service-card-pro')
  })

  it('bold variant includes service icons via --feature-icon', () => {
    expect(homepage('bold')).toContain('--feature-icon')
  })

  it('all variant cards contain .answer-block inside', () => {
    expect(homepage('bold')).toContain('answer-block')
    expect(homepage('minimal')).toContain('answer-block')
    expect(homepage('professional')).toContain('answer-block')
  })
})

// ── Trust section ──────────────────────────────────────────────────────────────

describe('trust section', () => {
  it('renders .trust-stat for foundedYear', () => {
    expect(homepage()).toContain('class="trust-stat"')
    expect(homepage()).toContain('class="trust-stat-number"')
  })

  it('renders .trust-pill for each credential', () => {
    const html = homepage()
    expect(html).toContain('class="trust-pill"')
    expect(html).toContain('Licensed by the Israel Board of Cosmetology')
  })

  it('renders .trust-area for service area', () => {
    expect(homepage()).toContain('class="trust-area"')
  })
})

// ── Footer ─────────────────────────────────────────────────────────────────────

describe('footer', () => {
  it('footer has .footer-inner', () => {
    expect(homepage()).toContain('class="footer-inner"')
  })

  it('footer has .footer-brand', () => {
    expect(homepage()).toContain('class="footer-brand"')
  })

  it('footer has footer navigation column', () => {
    expect(homepage()).toContain('aria-label="Footer navigation"')
  })

  it('footer shows copyright year from generatedAt', () => {
    // generatedAt is '2026-05-07T12:00:00Z' → year 2026
    expect(homepage()).toContain('2026')
    expect(homepage()).toContain('Test Salon')
  })

  it('footer has opening hours column', () => {
    expect(homepage()).toContain('class="footer-col-label"')
  })
})
