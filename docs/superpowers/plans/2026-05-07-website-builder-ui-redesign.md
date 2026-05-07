# Website Builder UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a dramatic visual redesign of the generated business websites — design token system, split hero, variant-specific service cards, stat-forward trust section, 3-column footer, and 3 responsive breakpoints — while preserving all AEO signals exactly.

**Architecture:** Two files change: `src/routes/build-site/styles.ts` (full rewrite — token system + all component CSS) and `src/routes/build-site/renderer.ts` (targeted changes — HTML structure for hero, service cards, trust, footer, section classes, nav aria-current). All other files — `aeo-layer.ts`, `site-schema.ts`, `palettes.ts`, `index.ts` — are untouched. No JS is added; all CSS is inlined.

**Tech Stack:** TypeScript template literals, pure inlined CSS, Vitest, `npx tsx` for the preview script.

---

## File map

| File | Change type | What changes |
|---|---|---|
| `src/routes/build-site/styles.ts` | Full rewrite | Design token CSS vars, all component CSS, 3 variant overrides, 3 breakpoints |
| `src/routes/build-site/renderer.ts` | Targeted edits | `NavLink` type, `pageShell` (nav + footer), hero, service cards, trust, section classes |
| `src/routes/build-site/renderer.test.ts` | New file | 20 assertions covering all spec behaviours |

---

## Task 1: Create `renderer.test.ts` with failing tests

This file will fail until Tasks 3–7 are complete. Run it after each task to track progress.

**Files:**
- Create: `src/routes/build-site/renderer.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
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
    expect(html).toContain('faq-answer')
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
    expect(html).toContain('service-feature')
  })

  it('minimal variant renders .services-grid with .service-card', () => {
    const html = homepage('minimal')
    expect(html).toContain('class="services-grid"')
    expect(html).toContain('class="service-card"')
  })

  it('professional variant renders .services-grid with .service-card-pro', () => {
    const html = homepage('professional')
    expect(html).toContain('class="services-grid"')
    expect(html).toContain('service-card-pro')
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx vitest run src/routes/build-site/renderer.test.ts 2>&1 | tail -30
```

Expected: many failures. `class="hero-inner"` not found, `aria-current` not found, `.service-feature` not found, etc. The file must compile without TypeScript errors though.

- [ ] **Step 3: Commit the test scaffold**

```bash
git add src/routes/build-site/renderer.test.ts
git commit -m "test: add renderer test scaffold for UI redesign (all failing)"
```

---

## Task 2: Rewrite `styles.ts`

Replaces the existing `buildCSS()` implementation with a token-based system. All CSS is still inlined into `<style>` tags. Removes the `section:nth-child(even)` rule (explicit section classes replace it). Removes the `variantFont()` function (body is now always system-ui; `--font-heading` is variant-specific). Replaces all per-variant helper functions with a single `variantTokens()` lookup.

**Files:**
- Modify: `src/routes/build-site/styles.ts` (full rewrite)

- [ ] **Step 1: Rewrite the file**

```typescript
// src/routes/build-site/styles.ts
import type { Palette } from './palettes.js'

export type StyleVariant = 'minimal' | 'bold' | 'professional'

interface VariantTokens {
  radius: string
  headingWeight: string
  fontHeading: string
  sectionPadding: string
  heroPadding: string
  heroH1Max: string
}

function variantTokens(v: StyleVariant): VariantTokens {
  const map: Record<StyleVariant, VariantTokens> = {
    minimal: {
      radius: '0.5rem',
      headingWeight: '700',
      fontHeading: 'system-ui, -apple-system, sans-serif',
      sectionPadding: '5rem',
      heroPadding: '5rem 0',
      heroH1Max: '3rem',
    },
    bold: {
      radius: '0.875rem',
      headingWeight: '800',
      fontHeading: 'system-ui, -apple-system, sans-serif',
      sectionPadding: '6rem',
      heroPadding: '7rem 0',
      heroH1Max: '3.5rem',
    },
    professional: {
      radius: '0.25rem',
      headingWeight: '700',
      fontHeading: 'Georgia, "Times New Roman", serif',
      sectionPadding: '5.5rem',
      heroPadding: '5.5rem 0',
      heroH1Max: '2.75rem',
    },
  }
  return map[v]
}

export function buildCSS(variant: StyleVariant, palette: Palette, dir: 'ltr' | 'rtl'): string {
  const t = variantTokens(variant)
  const marginStart = dir === 'rtl' ? 'margin-right' : 'margin-left'
  const marginEnd = dir === 'rtl' ? 'margin-left' : 'margin-right'
  const paddingStart = dir === 'rtl' ? 'padding-right' : 'padding-left'
  const sideFixed = dir === 'rtl' ? 'left' : 'right'

  return `
:root {
  /* Palette */
  --color-primary: ${palette.primary};
  --color-accent: ${palette.accent};
  --color-surface: ${palette.surface};
  --color-text: ${palette.text};
  --color-border: ${palette.border};
  --color-accent-text: ${palette.accentText};

  /* Type scale */
  --text-xs:      0.75rem;
  --text-sm:      0.875rem;
  --text-base:    1rem;
  --text-lg:      1.125rem;
  --text-xl:      1.25rem;
  --text-2xl:     1.5rem;
  --text-3xl:     2rem;
  --text-display: clamp(2.25rem, 5vw, ${t.heroH1Max});

  /* Spacing */
  --space-1:  0.25rem;
  --space-2:  0.5rem;
  --space-3:  0.75rem;
  --space-4:  1rem;
  --space-6:  1.5rem;
  --space-8:  2rem;
  --space-12: 3rem;
  --space-16: 4rem;
  --space-24: 6rem;

  /* Shadows */
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06);
  --shadow-lg: 0 10px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06);

  /* Variant tokens */
  --radius:          ${t.radius};
  --heading-weight:  ${t.headingWeight};
  --font-heading:    ${t.fontHeading};
  --font-body:       system-ui, -apple-system, sans-serif;
  --section-padding: ${t.sectionPadding};
}

/* ── Reset ─────────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 16px; scroll-behavior: smooth; }
body {
  font-family: var(--font-body);
  color: var(--color-text);
  background: #ffffff;
  line-height: 1.6;
  direction: ${dir};
}
h1, h2, h3, h4 {
  font-family: var(--font-heading);
  font-weight: var(--heading-weight);
}
a { color: var(--color-primary); text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; height: auto; display: block; }

/* ── Layout ─────────────────────────────────────────────────────────────── */
.container { max-width: 1100px; margin: 0 auto; padding: 0 var(--space-6); }

/* ── Header ─────────────────────────────────────────────────────────────── */
header {
  background: var(--color-primary);
  color: #fff;
  padding: 1rem 0;
}
.header-inner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-4);
}
.site-name {
  font-size: 1.375rem;
  font-weight: var(--heading-weight);
  font-family: var(--font-heading);
  color: #fff;
  letter-spacing: -0.02em;
}
.site-tagline { font-size: var(--text-sm); opacity: 0.75; margin-top: 0.2rem; }
nav a {
  color: #fff;
  opacity: 0.75;
  ${marginStart}: var(--space-6);
  font-size: var(--text-sm);
}
nav a:hover { opacity: 1; text-decoration: none; }
nav a[aria-current="page"] {
  opacity: 1;
  border-bottom: 2px solid var(--color-accent);
  padding-bottom: 2px;
}

/* ── Section backgrounds ─────────────────────────────────────────────────── */
section { padding: var(--section-padding) 0; }
.section-light   { background: #ffffff; }
.section-surface { background: var(--color-surface); }
.section-dark    { background: var(--color-primary); color: #fff; }
.section-dark h2 { color: #fff; }

/* ── Typography ─────────────────────────────────────────────────────────── */
h2 {
  font-size: var(--text-2xl);
  color: var(--color-primary);
  margin-bottom: var(--space-6);
  line-height: 1.25;
}
h3 {
  font-size: var(--text-lg);
  color: var(--color-primary);
  margin-bottom: var(--space-2);
}

/* ── Answer blocks ──────────────────────────────────────────────────────── */
.answer-block { font-size: var(--text-base); line-height: 1.7; margin-bottom: var(--space-4); }
.answer-block p { margin-bottom: var(--space-3); }

/* ── Hero ───────────────────────────────────────────────────────────────── */
.hero {
  background: var(--color-primary);
  padding: ${t.heroPadding};
}
.hero-inner {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: var(--space-12);
  align-items: center;
}
.hero-eyebrow {
  font-size: var(--text-xs);
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-accent);
  margin-bottom: var(--space-3);
}
.hero h1 {
  font-size: var(--text-display);
  font-weight: var(--heading-weight);
  font-family: var(--font-heading);
  color: #fff;
  line-height: 1.1;
  margin-bottom: var(--space-4);
}
.hero .lead {
  font-size: var(--text-lg);
  color: rgba(255,255,255,0.8);
  max-width: 480px;
  margin-bottom: var(--space-8);
  line-height: 1.65;
}
.hero-panel {
  background: linear-gradient(135deg,
    rgba(255,255,255,0.06) 0%,
    rgba(255,255,255,0.03) 100%);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: var(--radius);
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.hero-service-card {
  background: rgba(255,255,255,0.08);
  border-radius: calc(var(--radius) * 0.75);
  padding: var(--space-3) var(--space-4);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.hero-service-name { font-size: var(--text-sm); font-weight: 600; color: rgba(255,255,255,0.9); }
.hero-service-meta { font-size: var(--text-xs); color: rgba(255,255,255,0.5); }

/* ── CTA buttons ────────────────────────────────────────────────────────── */
.cta-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  background: #25D366;
  color: #fff;
  padding: var(--space-3) var(--space-8);
  border-radius: var(--radius);
  font-weight: 700;
  font-size: var(--text-base);
  text-decoration: none;
}
.cta-btn:hover { opacity: 0.92; text-decoration: none; }
.cta-btn svg { width: 1.25rem; height: 1.25rem; fill: #fff; }
.cta-btn-outline {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border: 2px solid var(--color-accent);
  color: var(--color-accent);
  padding: var(--space-3) var(--space-8);
  border-radius: var(--radius);
  font-weight: 700;
  font-size: var(--text-base);
  text-decoration: none;
}
.cta-btn-outline:hover {
  background: var(--color-accent);
  color: var(--color-accent-text);
  text-decoration: none;
}

/* ── Service cards — minimal (elevated) ─────────────────────────────────── */
.services-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-6);
}
.service-card {
  background: #fff;
  border-radius: var(--radius);
  padding: var(--space-6);
  box-shadow: var(--shadow-md);
  border: 1px solid var(--color-border);
  transition: box-shadow 0.2s, transform 0.2s;
}
.service-card:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); }
.service-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-3);
}
.service-tag {
  display: inline-block;
  font-size: var(--text-xs);
  font-weight: 700;
  padding: 0.2rem 0.5rem;
  background: var(--color-surface);
  color: var(--color-primary);
  border-radius: 999px;
  white-space: nowrap;
}

/* ── Service cards — bold (feature blocks) ──────────────────────────────── */
.services-list { display: flex; flex-direction: column; }
.service-feature {
  padding: var(--space-8) 0 var(--space-8) var(--space-6);
  border-${dir === 'rtl' ? 'right' : 'left'}: 4px solid var(--color-accent);
}
.service-feature-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}
.service-feature-icon::before { content: var(--feature-icon); font-size: 1.5rem; }
.service-divider { border: none; border-top: 1px solid var(--color-border); margin: 0; }

/* ── Service cards — professional (filled header) ───────────────────────── */
.service-card-pro {
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--color-border);
}
.service-card-pro-header {
  background: var(--color-primary);
  color: #fff;
  padding: var(--space-4) var(--space-6);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.service-card-pro-header h3 { color: #fff; margin: 0; }
.service-card-pro-header .service-meta { color: rgba(255,255,255,0.65); }
.service-card-pro-body { background: #fff; padding: var(--space-4) var(--space-6); }

/* ── Shared service metadata ─────────────────────────────────────────────── */
.service-meta { font-size: var(--text-sm); color: #6b7280; margin: var(--space-2) 0; }
.service-price { font-weight: 700; color: var(--color-primary); font-size: var(--text-lg); }
.service-link { font-size: var(--text-sm); font-weight: 600; color: var(--color-accent); text-decoration: none; }
.service-link:hover { text-decoration: underline; }

/* ── Process steps ───────────────────────────────────────────────────────── */
.process-steps { margin: var(--space-4) 0; padding: 0; list-style: none; counter-reset: steps; }
.process-steps li {
  counter-increment: steps;
  display: flex;
  gap: var(--space-4);
  align-items: flex-start;
  margin-bottom: var(--space-3);
  font-size: var(--text-sm);
}
.process-steps li::before {
  content: counter(steps);
  background: var(--color-accent);
  color: var(--color-accent-text);
  min-width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: var(--text-sm);
  flex-shrink: 0;
}

/* ── FAQ ─────────────────────────────────────────────────────────────────── */
.faq-list { counter-reset: faqs; }
.faq-item { border-bottom: 1px solid var(--color-border); padding: var(--space-6) 0; counter-increment: faqs; }
.faq-item:last-child { border-bottom: none; }
.faq-question {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--color-primary);
  margin-bottom: var(--space-3);
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}
.faq-question::before {
  content: counter(faqs, decimal-leading-zero);
  font-size: var(--text-xs);
  font-weight: 700;
  color: var(--color-accent);
  padding-top: 0.2rem;
  flex-shrink: 0;
}
.faq-answer {
  font-size: var(--text-sm);
  line-height: 1.75;
  color: #475569;
  ${paddingStart}: var(--space-8);
  border-${dir === 'rtl' ? 'right' : 'left'}: 3px solid var(--color-border);
  margin-${dir === 'rtl' ? 'right' : 'left'}: calc(var(--space-8) - var(--space-4));
}

/* ── Trust section ───────────────────────────────────────────────────────── */
.trust-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-6);
  margin-top: var(--space-6);
}
.trust-stat { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-1); }
.trust-stat-number { font-size: var(--text-3xl); font-weight: 800; color: var(--color-primary); line-height: 1; }
.trust-stat-label { font-size: var(--text-sm); color: #6b7280; }
.trust-credentials { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: flex-start; }
.trust-pill {
  display: inline-block;
  font-size: var(--text-xs);
  padding: 0.25rem 0.75rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-primary);
}
.trust-area { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--color-primary); }
.trust-icon { font-size: 1.25rem; }

/* ── CTA section ─────────────────────────────────────────────────────────── */
.cta-section { text-align: center; padding: var(--space-16) 0; }
.cta-section h2 { color: #fff; }
.cta-section .answer-block { opacity: 0.9; margin-bottom: var(--space-6); }

/* ── Hours table ─────────────────────────────────────────────────────────── */
.hours-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.hours-table td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-border); }
.hours-table td:first-child { font-weight: 600; color: var(--color-primary); }

/* ── Contact block ───────────────────────────────────────────────────────── */
.contact-block {
  background: var(--color-surface);
  border-radius: var(--radius);
  padding: var(--space-8);
  margin-top: var(--space-6);
}
address { font-style: normal; line-height: 1.8; }

/* ── Footer ──────────────────────────────────────────────────────────────── */
footer {
  background: var(--color-primary);
  color: rgba(255,255,255,0.8);
  padding: var(--space-16) 0 var(--space-8);
  font-size: var(--text-sm);
}
footer address { color: rgba(255,255,255,0.7); }
footer a { color: rgba(255,255,255,0.85); }
footer a:hover { text-decoration: underline; }
.footer-inner {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: var(--space-12);
  padding-bottom: var(--space-8);
  border-bottom: 1px solid rgba(255,255,255,0.1);
}
.footer-brand {
  font-size: var(--text-base);
  font-weight: 700;
  font-family: var(--font-heading);
  color: #fff;
  display: block;
  margin-bottom: var(--space-4);
}
.footer-col-label {
  font-size: var(--text-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.4);
  margin-bottom: var(--space-4);
}
.footer-col nav a { display: block; ${marginStart}: 0; margin-bottom: var(--space-2); font-size: var(--text-sm); }
.footer-hours { font-size: var(--text-sm); color: rgba(255,255,255,0.7); line-height: 1.8; }
.footer-bottom { padding-top: var(--space-4); font-size: var(--text-xs); color: rgba(255,255,255,0.35); }

/* ── About page ──────────────────────────────────────────────────────────── */
.practitioner-card { display: flex; gap: var(--space-8); align-items: flex-start; flex-wrap: wrap; margin-top: var(--space-6); }
.practitioner-bio { flex: 1; min-width: 240px; }
.credentials-list { margin-top: var(--space-4); ${paddingStart}: var(--space-6); }
.credentials-list li { margin-bottom: var(--space-2); font-size: var(--text-sm); }

/* ── WhatsApp sticky CTA ─────────────────────────────────────────────────── */
.wa-cta {
  position: fixed;
  bottom: var(--space-6);
  ${sideFixed}: var(--space-6);
  width: 3.5rem;
  height: 3.5rem;
  background: #25D366;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-lg);
  z-index: 9999;
  transition: transform 0.2s;
}
.wa-cta:hover { transform: scale(1.08); text-decoration: none; }
.wa-cta svg { width: 2rem; height: 2rem; fill: #fff; }

/* ── Responsive: 1100px ──────────────────────────────────────────────────── */
@media (max-width: 1100px) {
  .container { padding: 0 var(--space-8); }
}

/* ── Responsive: 768px ───────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .hero-inner { grid-template-columns: 1fr; }
  .hero-panel { display: none; }
  .hero { text-align: center; }
  .hero .lead { margin-left: auto; margin-right: auto; }
  .footer-inner { grid-template-columns: 1fr; gap: var(--space-8); }
  .footer-col:last-child { display: none; }
  .services-grid { grid-template-columns: 1fr 1fr; }
}

/* ── Responsive: 480px ───────────────────────────────────────────────────── */
@media (max-width: 480px) {
  section { padding: var(--space-12) 0; }
  .services-grid,
  .trust-grid { grid-template-columns: 1fr; }
  .header-inner { flex-direction: column; align-items: flex-start; }
  nav { margin-top: var(--space-2); }
  nav a { ${marginStart}: 0; ${marginEnd}: var(--space-4); }
  .hero { padding: var(--space-12) 0; }
  .hero h1 { font-size: var(--text-2xl); }
  .footer-inner { grid-template-columns: 1fr; }
}
`
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx tsc --noEmit 2>&1 | grep "styles.ts" | head -20
```

Expected: no errors referencing `styles.ts`. (Other pre-existing errors are acceptable.)

- [ ] **Step 3: Commit**

```bash
git add src/routes/build-site/styles.ts
git commit -m "feat: rewrite styles.ts with CSS token system and all new component styles"
```

---

## Task 3: Nav `aria-current` + 3-column footer in `renderer.ts`

Changes `pageShell` to accept a typed `NavLink[]` array instead of a pre-built string. Builds nav HTML inside `pageShell` with `aria-current="page"` on the active link. Rewrites the footer to a 3-column layout with copyright year. Propagates the signature change to `renderSite` and all 5 page render functions.

**Files:**
- Modify: `src/routes/build-site/renderer.ts`

- [ ] **Step 1: Add `NavLink` type and update `pageShell` signature at the top of the file**

Replace the `pageShell` function signature and implementation. Find the current function (lines 39–117) and replace it entirely:

```typescript
// Add type after the existing WA_ICON_SVG const (around line 25):
type NavLink = { href: string; label: string; path: string }
```

- [ ] **Step 2: Replace `pageShell` entirely**

Find the current `pageShell` function (starts at `function pageShell(params: {`) and replace it with:

```typescript
function pageShell(params: {
  title: string
  description: string
  canonical: string
  siteUrl: string
  schema: SiteSchema
  css: string
  jsonLdBlocks: object[]
  bodyContent: string
  dir: 'rtl' | 'ltr'
  lang: string
  navLinks: NavLink[]
  currentPath: string
}): string {
  const { title, description, canonical, siteUrl, schema, css, jsonLdBlocks, bodyContent, dir, lang, navLinks, currentPath } = params
  const biz = schema.business
  const ogImage = schema.style.heroImageUrl ?? ''
  const jsonLdHtml = jsonLdBlocks.map(serializeJsonLd).join('\n')
  const phone = biz.phone
  const isHe = lang === 'he'

  const navHtml = navLinks
    .map((l) => `<a href="${e(l.href)}"${l.path === currentPath ? ' aria-current="page"' : ''}>${e(l.label)}</a>`)
    .join('')

  const header = `
<header>
  <div class="container">
    <div class="header-inner">
      <div>
        ${schema.style.logoUrl ? `<img src="${e(schema.style.logoUrl)}" alt="${e(biz.name)} logo" height="48" style="height:48px;width:auto;">` : `<span class="site-name">${e(biz.name)}</span>`}
        <p class="site-tagline">${e(biz.tagline)}</p>
      </div>
      <nav aria-label="Main navigation">${navHtml}</nav>
    </div>
  </div>
</header>`

  const copyrightYear = new Date(schema.generatedAt).getFullYear()

  // Opening hours for footer (first 2 blocks)
  const footerHoursHtml = biz.openingHours.slice(0, 2).map((h) =>
    `<p>${e(h.dayOfWeek.join(', '))}: ${e(h.opens)}–${e(h.closes)}</p>`
  ).join('')

  const footer = `
<footer>
  <div class="container">
    <div class="footer-inner">
      <div class="footer-col">
        <strong class="footer-brand">${e(biz.name)}</strong>
        <address>
          ${biz.address ? e(biz.address) + ', ' : ''}${e(biz.city)}<br>
          <a href="${waLink(phone)}">${e(phone)}</a>
        </address>
      </div>
      <div class="footer-col">
        <p class="footer-col-label">${isHe ? 'ניווט' : 'Quick links'}</p>
        <nav aria-label="Footer navigation">${navHtml}</nav>
      </div>
      ${biz.openingHours.length > 0 ? `
      <div class="footer-col">
        <p class="footer-col-label">${isHe ? 'שעות פעילות' : 'Opening hours'}</p>
        <div class="footer-hours">${footerHoursHtml}</div>
      </div>` : '<div class="footer-col"></div>'}
    </div>
    <div class="footer-bottom">
      <p>© ${copyrightYear} ${e(biz.name)}</p>
    </div>
  </div>
</footer>`

  const waBtn = `
<a class="wa-cta" href="${waLink(phone)}" aria-label="${isHe ? 'שוחח איתנו בווטסאפ' : 'Chat with us on WhatsApp'}" rel="noopener">
  ${WA_ICON_SVG}
</a>`

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${e(title)}</title>
  <meta name="description" content="${e(description)}">
  <link rel="canonical" href="${e(canonical)}">
  <meta property="og:title" content="${e(title)}">
  <meta property="og:description" content="${e(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${e(canonical)}">
  ${ogImage ? `<meta property="og:image" content="${e(ogImage)}">` : ''}
  <meta property="og:site_name" content="${e(biz.name)}">
  ${jsonLdHtml}
  <style>${css}</style>
</head>
<body>
${header}
<main>
${bodyContent}
</main>
${footer}
${waBtn}
</body>
</html>`
}
```

- [ ] **Step 3: Update all page render function signatures (`nav: string` → `navLinks: NavLink[]`)**

Update the 5 page functions and `renderSite`. The signatures change from `nav: string` to `navLinks: NavLink[]`. Inside each page function the call to `pageShell` changes `nav` → `navLinks`.

**In `renderHomepage`:** Change `nav: string` to `navLinks: NavLink[]` in signature, and update the `pageShell` call:
```typescript
// Change function signature:
function renderHomepage(schema: SiteSchema, siteUrl: string, css: string, dir: 'rtl' | 'ltr', navLinks: NavLink[]): string {

// Update the pageShell call at the bottom (remove `nav`, add `navLinks`):
return pageShell({ title, description, canonical, siteUrl, schema, css, jsonLdBlocks, bodyContent, dir, lang, navLinks, currentPath: '/' })
```

Apply the same `nav: string` → `navLinks: NavLink[]` change to:
- `renderServicesPage` (currentPath: `'/services/'`)
- `renderFaqPage` (currentPath: `'/faq/'`)
- `renderContactPage` (currentPath: `'/contact/'`)
- `renderAboutPage` (currentPath: `'/about/'`)

- [ ] **Step 4: Update `renderSite` — build `NavLink[]` array instead of pre-built string**

Replace in `renderSite`:
```typescript
// REMOVE this:
const nav = navLinks.map((l) => `<a href="${e(l.href)}">${e(l.label)}</a>`).join('')

// KEEP navLinks array but add `path` field to each entry:
const navLinks: NavLink[] = [
  { href: siteUrl + '/', path: '/', label: isHe ? 'בית' : 'Home' },
  { href: siteUrl + '/services/', path: '/services/', label: isHe ? 'שירותים' : 'Services' },
  { href: siteUrl + '/faq/', path: '/faq/', label: 'FAQ' },
  ...(schema.business.practitionerName ? [{ href: siteUrl + '/about/', path: '/about/', label: isHe ? 'אודות' : 'About' }] : []),
  { href: siteUrl + '/contact/', path: '/contact/', label: isHe ? 'צור קשר' : 'Contact' },
]

// Update each renderXxx call to pass navLinks instead of nav:
'index.html': renderHomepage(schema, siteUrl, css, dir, navLinks),
'services/index.html': renderServicesPage(schema, siteUrl, css, dir, navLinks),
'faq/index.html': renderFaqPage(schema, siteUrl, css, dir, navLinks),
'contact/index.html': renderContactPage(schema, siteUrl, css, dir, navLinks),
// and for about:
const aboutHtml = renderAboutPage(schema, siteUrl, css, dir, navLinks)
```

- [ ] **Step 5: Run TypeScript check**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx tsc --noEmit 2>&1 | grep "renderer.ts" | head -20
```

Expected: no errors on `renderer.ts`.

- [ ] **Step 6: Run tests to check progress**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx vitest run src/routes/build-site/renderer.test.ts 2>&1 | tail -40
```

Expected: nav aria-current tests now pass. Footer tests now pass. Hero tests still fail (hero-inner not yet added).

- [ ] **Step 7: Commit**

```bash
git add src/routes/build-site/renderer.ts
git commit -m "feat: nav aria-current and 3-column footer in renderer"
```

---

## Task 4: Split hero in `renderer.ts`

Replaces the centred single-column hero with a `3fr 2fr` grid: left panel has eyebrow + h1 + lead + CTA button; right panel (`aria-hidden`) shows 2–3 service highlights. The `h1` content changes to use the business name + tagline rather than the page title string (the spec calls for a standalone h1 separate from the `<title>` tag).

**Files:**
- Modify: `src/routes/build-site/renderer.ts` — `renderHomepage` function

- [ ] **Step 1: Replace `heroHtml` in `renderHomepage`**

Find the current `const heroHtml = ...` block (approx lines 133–144) and replace it:

```typescript
const heroHtml = `
<section class="hero" aria-label="${isHe ? 'כותרת ראשית' : 'Hero'}">
  <div class="container">
    <div class="hero-inner">

      <div class="hero-text">
        <p class="hero-eyebrow">${e(biz.category)} · ${e(biz.city)}</p>
        <h1>${e(biz.name)}</h1>
        <p class="lead answer-block">${e(biz.description)}</p>
        <a class="cta-btn" href="${waLink(biz.phone)}" rel="noopener">
          ${WA_ICON_SVG}
          ${isHe ? 'הזמינו דרך וואטסאפ' : 'Book via WhatsApp'}
        </a>
      </div>

      <div class="hero-panel" aria-hidden="true">
        ${schema.services.slice(0, 3).map((s) => {
          const priceStr = s.price !== null
            ? `${s.price} ${s.currency}`
            : (isHe ? 'מחיר לפי בקשה' : 'Price on request')
          return `
        <div class="hero-service-card">
          <span class="hero-service-name">${e(s.name)}</span>
          <span class="hero-service-meta">${e(priceStr)}</span>
        </div>`
        }).join('')}
      </div>

    </div>
  </div>
</section>`
```

- [ ] **Step 2: Run tests to check progress**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx vitest run src/routes/build-site/renderer.test.ts 2>&1 | tail -40
```

Expected: split hero tests now pass (`hero-inner`, `hero-text`, `hero-panel`, `aria-hidden="true"`, `hero-service-card`, `hero-eyebrow` all found). AEO `lead answer-block` test still passes.

- [ ] **Step 3: Commit**

```bash
git add src/routes/build-site/renderer.ts
git commit -m "feat: replace centred hero with split 3fr/2fr grid layout"
```

---

## Task 5: Add section classes to all pages in `renderer.ts`

Adds explicit `.section-light`, `.section-surface`, `.section-dark` CSS classes to every `<section>` tag across all 5 page render functions. Removes inline `style="padding-top:..."` attributes that duplicate the section padding (now handled by the `section` base rule). The `section:nth-child(even)` rule is already removed from `styles.ts`, so sections without a class will render on white — that's fine as `.section-light` behaviour.

**Files:**
- Modify: `src/routes/build-site/renderer.ts`

- [ ] **Step 1: Update sections in `renderHomepage`**

Apply these class additions to each section inside `renderHomepage`:

| Section | Current opening tag | New opening tag |
|---|---|---|
| Services | `<section aria-labelledby="services-heading">` | `<section class="section-surface" aria-labelledby="services-heading">` |
| Trust | `<section aria-labelledby="trust-heading">` | `<section class="section-light" aria-labelledby="trust-heading">` |
| FAQ | `<section aria-labelledby="faq-heading">` | `<section class="section-surface" aria-labelledby="faq-heading">` |
| CTA | `<section class="cta-section" aria-labelledby="cta-heading">` | `<section class="cta-section section-dark" aria-labelledby="cta-heading">` |

- [ ] **Step 2: Update sections in `renderServicesPage`**

```typescript
// Replace the bodyContent template:
const bodyContent = `
<section class="section-surface" style="padding-top:2.5rem;padding-bottom:1rem;">
  <div class="container">
    <h1>${isHe ? `השירותים של ${biz.name}` : `Services at ${biz.name}`}</h1>
    <div class="answer-block"><p>${e(description)}</p></div>
  </div>
</section>
<section class="section-light">
  <div class="container">
    ${serviceBlocks}
  </div>
</section>`
```

- [ ] **Step 3: Update sections in `renderFaqPage`**

In the `bodyFaqHtml` loop — each topic section gets `.section-surface` or `.section-light` alternating. Add an index:

```typescript
let bodyFaqHtml = ''
let sectionIndex = 0
for (const { key, label } of topics) {
  const group = allFaqs.filter((f) => f.topic === key)
  if (group.length === 0) continue
  const sectionClass = sectionIndex % 2 === 0 ? 'section-surface' : 'section-light'
  bodyFaqHtml += `
<section class="${sectionClass}" aria-labelledby="faq-${key}">
  <div class="container">
    <h2 id="faq-${key}">${e(label)}</h2>
    <div class="faq-list">
      ${group.map((f) => `
      <div class="faq-item">
        <h3 class="faq-question">${e(f.question)}</h3>
        <div class="faq-answer answer-block">${e(f.answer)}</div>
      </div>`).join('')}
    </div>
  </div>
</section>`
  sectionIndex++
}
```

Also update the intro section and CTA at the bottom:
```typescript
// intro section:
<section class="section-surface" style="padding-top:2.5rem;padding-bottom:1rem;">

// CTA at bottom:
<section class="cta-section section-dark" aria-label="${isHe ? 'הזמנה' : 'Booking'}">
```

- [ ] **Step 4: Update sections in `renderContactPage`**

```typescript
// Intro section:
<section class="section-surface" style="padding-top:2.5rem;padding-bottom:1rem;">

// Book section:
<section class="section-light" aria-labelledby="book-heading">

// Hours section (hoursHtml):
<section class="section-surface" aria-labelledby="hours-heading">

// Location section (locationHtml):
<section class="section-light" aria-labelledby="location-heading">
```

- [ ] **Step 5: Update sections in `renderAboutPage`**

```typescript
// Intro/practitioner section:
<section class="section-light" style="padding-top:2.5rem;">

// Booking CTA section:
<section class="cta-section section-dark" aria-label="${isHe ? 'הזמנה' : 'Booking'}">
```

- [ ] **Step 6: Run TypeScript check**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx tsc --noEmit 2>&1 | grep "renderer.ts" | head -10
```

Expected: no errors.

- [ ] **Step 7: Run tests to check progress**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx vitest run src/routes/build-site/renderer.test.ts 2>&1 | tail -40
```

Expected: section class tests now pass. Service card variant tests still fail.

- [ ] **Step 8: Commit**

```bash
git add src/routes/build-site/renderer.ts
git commit -m "feat: add explicit section-light/surface/dark classes to all pages"
```

---

## Task 6: Variant-driven service cards in `renderer.ts`

Extracts a `renderServiceCards()` helper that emits different HTML for `bold` (feature blocks), `minimal` (elevated cards), and `professional` (filled-header cards). Used only in the homepage services section. The services page keeps its existing full-article format.

**Files:**
- Modify: `src/routes/build-site/renderer.ts`

- [ ] **Step 1: Add `SERVICE_ICONS` constant and `renderServiceCards` function**

Add before `renderHomepage` (after the `waLink` helper function):

```typescript
const SERVICE_ICONS = ['📱', '🧠', '🌐', '✂️', '💆', '🏋️', '📸', '🎵']

function renderServiceCards(
  services: SiteSchema['services'],
  variant: SiteSchema['style']['variant'],
  isHe: boolean,
  phone: string,
): string {
  const priceStr = (s: SiteSchema['services'][number]): string => {
    if (s.price !== null) return `${s.price} ${s.currency}`
    if (s.priceOnRequest) return isHe ? 'מחיר לפי בקשה' : 'Price on request'
    return ''
  }

  if (variant === 'bold') {
    const items = services.map((s, i) => {
      const icon = SERVICE_ICONS[i % SERVICE_ICONS.length] ?? '✨'
      const price = priceStr(s)
      return `
<article class="service-feature" style="--feature-icon: '${icon}'">
  <div class="service-feature-header">
    <span class="service-feature-icon" aria-hidden="true"></span>
    <h3>${e(s.name)}</h3>
  </div>
  <p class="service-meta">${s.durationMinutes} ${isHe ? 'דקות' : 'min'}${price ? ' · ' + e(price) : ''}</p>
  <div class="answer-block"><p>${e(s.description)}</p></div>
  <a class="service-link" href="${waLink(phone)}">${isHe ? `הזמינו ${e(s.name)}` : `Book ${e(s.name)}`} →</a>
</article>
${i < services.length - 1 ? '<hr class="service-divider">' : ''}`
    }).join('')
    return `<div class="services-list">${items}</div>`
  }

  if (variant === 'professional') {
    const cards = services.map((s) => {
      const price = priceStr(s)
      return `
<article class="service-card-pro">
  <div class="service-card-pro-header">
    <h3>${e(s.name)}</h3>
    <span class="service-meta">${e(price || (isHe ? 'מחיר לפי בקשה' : 'Price on request'))}</span>
  </div>
  <div class="service-card-pro-body">
    <div class="answer-block"><p>${e(s.description)}</p></div>
    <a class="service-link" href="${waLink(phone)}">${isHe ? 'הזמינו דרך וואטסאפ' : 'Book via WhatsApp'} →</a>
  </div>
</article>`
    }).join('')
    return `<div class="services-grid">${cards}</div>`
  }

  // minimal (default)
  const cards = services.map((s) => {
    const price = priceStr(s)
    return `
<article class="service-card">
  <div class="service-card-header">
    <h3>${e(s.name)}</h3>
    <span class="service-tag">${e(price || (isHe ? 'מחיר לפי בקשה' : 'On request'))}</span>
  </div>
  <p class="service-meta">${s.durationMinutes} ${isHe ? 'דקות' : 'min'}</p>
  <div class="answer-block"><p>${e(s.description)}</p></div>
  <a class="service-link" href="${waLink(phone)}">${isHe ? 'לפרטים נוספים' : 'Learn more'} →</a>
</article>`
  }).join('')
  return `<div class="services-grid">${cards}</div>`
}
```

- [ ] **Step 2: Replace the services section in `renderHomepage`**

Find the current `serviceCards` + `servicesSection` block and replace it:

```typescript
const servicesLabel = isHe ? `אילו שירותים מציע ${biz.name}?` : `What services does ${biz.name} offer?`

const servicesSection = `
<section class="section-surface" aria-labelledby="services-heading">
  <div class="container">
    <h2 id="services-heading">${e(servicesLabel)}</h2>
    ${renderServiceCards(schema.services, schema.style.variant, isHe, biz.phone)}
    <p style="margin-top:1.5rem">
      <a href="${siteUrl}/services/">${isHe ? 'לכל השירותים ←' : 'View all services →'}</a>
    </p>
  </div>
</section>`
```

Note: The old `serviceCards` variable and the old `servicesSection` that wraps `.services-grid` with `${serviceCards}` are both replaced by this block.

- [ ] **Step 3: Run TypeScript check**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx tsc --noEmit 2>&1 | grep "renderer.ts" | head -10
```

Expected: no errors.

- [ ] **Step 4: Run tests to check progress**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx vitest run src/routes/build-site/renderer.test.ts 2>&1 | tail -40
```

Expected: variant service card tests now pass. Trust section tests still fail.

- [ ] **Step 5: Commit**

```bash
git add src/routes/build-site/renderer.ts
git commit -m "feat: variant-driven service cards (bold=feature blocks, minimal=elevated, professional=filled-header)"
```

---

## Task 7: Trust section stat-forward redesign in `renderer.ts`

Replaces the plain checkmark list with stat cards (`trust-stat`), credential pills (`trust-pill`), and a service-area block (`trust-area`). Logic: if `foundedYear` is set, emit a years-of-experience stat; credentials become pills; service area (if multiple) becomes a `trust-area`. Fallback to 2 generic trust items only if nothing else is available.

**Files:**
- Modify: `src/routes/build-site/renderer.ts` — `renderHomepage` function

- [ ] **Step 1: Replace the trust section logic in `renderHomepage`**

Find the current trust section (the `const trustItems` block through `const trustSection = ...`) and replace it entirely:

```typescript
const trustLabel = isHe ? `למה לבחור ב-${biz.name}?` : `Why choose ${biz.name}?`

const trustItems: string[] = []

// Stat: years of experience
if (biz.foundedYear) {
  const years = new Date().getFullYear() - biz.foundedYear
  trustItems.push(`
<div class="trust-stat">
  <span class="trust-stat-number">${years}+</span>
  <span class="trust-stat-label">${isHe ? 'שנות ניסיון' : 'years of experience'}</span>
</div>`)
}

// Credentials as pills
if (biz.credentials.length > 0) {
  const pills = biz.credentials.slice(0, 4).map((c) => `<span class="trust-pill">${e(c)}</span>`).join('')
  trustItems.push(`<div class="trust-credentials">${pills}</div>`)
}

// Service area
if (biz.serviceArea.length > 1) {
  trustItems.push(`
<div class="trust-area">
  <span class="trust-icon">📍</span>
  <span>${isHe ? 'שירות ב-' : 'Serving '}${e(biz.serviceArea.join(', '))}</span>
</div>`)
}

// Fallback
if (trustItems.length === 0) {
  trustItems.push(`
<div class="trust-credentials">
  <span class="trust-pill">${isHe ? 'שירות מקצועי ואיכותי' : 'Professional quality service'}</span>
  <span class="trust-pill">${isHe ? 'הזמנה קלה דרך וואטסאפ' : 'Easy booking via WhatsApp'}</span>
</div>`)
}

const trustSection = `
<section class="section-light" aria-labelledby="trust-heading">
  <div class="container">
    <h2 id="trust-heading">${e(trustLabel)}</h2>
    <div class="trust-grid">
      ${trustItems.join('\n')}
    </div>
  </div>
</section>`
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx tsc --noEmit 2>&1 | grep "renderer.ts" | head -10
```

Expected: no errors.

- [ ] **Step 3: Run all renderer tests**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx vitest run src/routes/build-site/renderer.test.ts 2>&1 | tail -50
```

Expected: all tests pass (or very close — footer copyright year test depends on the `generatedAt` year in the fixture matching `2026`).

- [ ] **Step 4: Run full test suite**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx vitest run 2>&1 | tail -20
```

Expected: all pre-existing tests continue to pass. No regressions.

- [ ] **Step 5: Run TypeScript build**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx tsc --noEmit 2>&1 | head -30
```

Expected: same output as before this task began (zero new errors).

- [ ] **Step 6: Commit**

```bash
git add src/routes/build-site/renderer.ts
git commit -m "feat: trust section stat-forward redesign (years, credential pills, service area)"
```

---

## Task 8: Final verification — preview and build check

Regenerates the MiddleMan preview site and visually confirms all spec elements are in place. Runs the full lint and build.

**Files:**
- No file changes. Read-only verification.

- [ ] **Step 1: Regenerate the MiddleMan preview**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx tsx scripts/preview-middleman.ts 2>&1
```

Expected output includes: `✅ Preview written to /tmp/middleman-preview/` (or similar). No errors.

- [ ] **Step 2: Check generated HTML for key spec elements**

```bash
# Split hero present
grep -c "hero-inner" /tmp/middleman-preview/index.html

# aria-current on Home link
grep "aria-current" /tmp/middleman-preview/index.html | head -3

# Footer 3-col
grep "footer-inner" /tmp/middleman-preview/index.html

# Section classes
grep -E "section-(light|surface|dark)" /tmp/middleman-preview/index.html | head -5

# AEO: answer-block
grep -c "answer-block" /tmp/middleman-preview/index.html

# AEO: faq-item
grep -c "faq-item" /tmp/middleman-preview/index.html
```

Expected:
- `hero-inner`: 1
- `aria-current="page"` appears on the Home nav link
- `footer-inner` present
- Multiple `section-surface` and `section-dark` classes
- `answer-block` count ≥ 3
- `faq-item` count ≥ 5

- [ ] **Step 3: Verify all 3 variants in preview (visual spot-check)**

Edit `scripts/preview-middleman.ts` temporarily, change `variant: 'professional'` to `'bold'`, run the script, check `/tmp/middleman-preview/index.html` for `.services-list` and `.service-feature`. Then try `'minimal'` and check for `.service-card`.

```bash
# Bold:
grep -c "service-feature" /tmp/middleman-preview/index.html
# Expected: > 0

# Minimal:
grep -c '"service-card"' /tmp/middleman-preview/index.html
# Expected: > 0
```

Then restore the preview script to `variant: 'professional'`.

- [ ] **Step 4: Run lint**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx eslint src/routes/build-site/ 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Run full build**

```bash
cd /Users/liadbourla/Desktop/PA_4_Business && npx tsc 2>&1 | head -20
```

Expected: exits 0, same errors as pre-implementation (if any pre-existing ones exist, they are unchanged).

- [ ] **Step 6: Final commit**

```bash
git add -p  # review any unstaged changes from step 3 (preview-middleman.ts variant restore)
git commit -m "test: restore preview-middleman variant to professional after spot-check"
# (only needed if preview script was temporarily changed)
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Implemented in |
|---|---|
| §2 Design token system | Task 2 (`styles.ts` `:root {}`) |
| §3 Navigation aria-current | Task 3 (`pageShell` nav build) |
| §4 Split hero 3fr/2fr | Task 4 (`renderHomepage` hero) |
| §5 Section rhythm classes | Task 5 (all page functions) |
| §6 Variant service cards | Task 6 (`renderServiceCards`) |
| §7 FAQ CSS counter treatment | Task 2 (`.faq-list counter-reset`, `.faq-question::before`) |
| §8 Trust stat-forward cards | Task 7 (trust section in `renderHomepage`) |
| §9 Footer 3-column | Task 3 (`pageShell` footer) |
| §10 3 responsive breakpoints | Task 2 (`styles.ts` `@media`) |
| §11 AEO preservation | Tests in Task 1; `.answer-block`, `.faq-*`, `<address>`, `aria-labelledby` all preserved |

**Placeholder check:** No TBDs or TODOs. All code blocks are complete.

**Type consistency check:** `NavLink` defined once in `renderer.ts`, used consistently across `pageShell`, all 5 render functions, and `renderSite`. `SiteSchema['style']['variant']` used directly in `renderServiceCards` (no external type import needed). `VariantTokens` interface defined and used only in `styles.ts`.

**AEO preservation check:**
- `.answer-block` still emitted on hero lead, service descriptions, FAQ answers — ✅
- `.faq-item`, `.faq-question`, `.faq-answer` class names unchanged — ✅
- `<address>` in footer — ✅
- `aria-labelledby` on sections — ✅
- `<h1>` on every page — ✅
- No `<script>` tags added — ✅
- JSON-LD blocks unchanged (`aeo-layer.ts` not touched) — ✅
- `hero-panel` has `aria-hidden="true"` and is `display:none` at ≤768px — ✅
