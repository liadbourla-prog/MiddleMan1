import type { SiteSchema, FaqEntry } from '../../skills/website-builder/site-schema.js'
import { buildCSS } from './styles.js'
import { resolvePalette } from './palettes.js'
import {
  buildLocalBusinessSchema,
  buildFaqPageSchema,
  buildServiceSchemas,
  buildPersonSchema,
  buildWebPageSchema,
  buildBreadcrumbSchema,
  buildSpeakableSchema,
  serializeJsonLd,
} from './aeo-layer.js'

export interface RenderedSite {
  'index.html': string
  'services/index.html': string
  'faq/index.html': string
  'contact/index.html': string
  'about/index.html'?: string
}

type NavLink = { href: string; label: string; path: string }

const WA_ICON_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
</svg>`

function e(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function waLink(phone: string): string {
  return `https://wa.me/${phone.replace(/\D/g, '')}`
}

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

// ── Homepage ──────────────────────────────────────────────────────────────────

function renderHomepage(schema: SiteSchema, siteUrl: string, css: string, dir: 'rtl' | 'ltr', navLinks: NavLink[]): string {
  const biz = schema.business
  const lang = schema.language
  const isHe = lang === 'he'

  const title = truncate(`${biz.name} — ${biz.category} ${isHe ? 'ב' : 'in '}${biz.city}`, 60)
  const description = truncate(biz.description, 155)
  const canonical = siteUrl + '/'

  // Top FAQs for homepage (first 5)
  const topFaqs = schema.faqs.slice(0, 5)

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

  const faqLabel = isHe ? `שאלות נפוצות על ${biz.name}` : `Common questions about ${biz.name}`
  const faqHtml = topFaqs.map((f) => `
<div class="faq-item">
  <p class="faq-question">${e(f.question)}</p>
  <div class="faq-answer answer-block">${e(f.answer)}</div>
</div>`).join('')

  const faqSection = topFaqs.length > 0 ? `
<section class="section-surface" aria-labelledby="faq-heading">
  <div class="container">
    <h2 id="faq-heading">${e(faqLabel)}</h2>
    <div class="faq-list">${faqHtml}</div>
    <p style="margin-top:1.5rem"><a href="${siteUrl}/faq/">${isHe ? 'לכל השאלות ←' : 'See all FAQs →'}</a></p>
  </div>
</section>` : ''

  const ctaLabel = isHe ? `איך מזמינים תור ב-${biz.name}?` : `How do I book at ${biz.name}?`
  const ctaSection = `
<section class="cta-section section-dark" aria-labelledby="cta-heading">
  <div class="container">
    <h2 id="cta-heading">${e(ctaLabel)}</h2>
    <p class="answer-block">${isHe ? `שלחו הודעה ל-${biz.name} דרך וואטסאפ — מענה מהיר, הזמנה קלה.` : `Send a message to ${biz.name} on WhatsApp — fast reply, easy booking.`}</p>
    <a class="cta-btn-outline" href="${waLink(biz.phone)}" rel="noopener">
      ${WA_ICON_SVG}
      ${isHe ? 'התחילו שיחה בוואטסאפ' : 'Start a WhatsApp conversation'}
    </a>
  </div>
</section>`

  const bodyContent = heroHtml + servicesSection + trustSection + faqSection + ctaSection

  const jsonLdBlocks: object[] = [
    buildLocalBusinessSchema(schema, siteUrl),
    buildWebPageSchema(title, canonical, siteUrl, description, schema.generatedAt),
    buildSpeakableSchema(),
    ...(topFaqs.length > 0 ? [buildFaqPageSchema(topFaqs)] : []),
  ]

  return pageShell({ title, description, canonical, siteUrl, schema, css, jsonLdBlocks, bodyContent, dir, lang, navLinks, currentPath: '/' })
}

// ── Services page ─────────────────────────────────────────────────────────────

function renderServicesPage(schema: SiteSchema, siteUrl: string, css: string, dir: 'rtl' | 'ltr', navLinks: NavLink[]): string {
  const biz = schema.business
  const lang = schema.language
  const isHe = lang === 'he'

  const title = truncate(`${isHe ? 'שירותים' : 'Services'} — ${biz.name}`, 60)
  const description = truncate(
    isHe ? `כל השירותים של ${biz.name} ב${biz.city}: מחירים, משכי זמן ומה לצפות.` : `All services at ${biz.name} in ${biz.city}: pricing, duration, and what to expect.`,
    155,
  )
  const canonical = siteUrl + '/services/'

  const serviceBlocks = schema.services.map((s) => {
    const priceStr = s.price !== null
      ? `${s.price} ${s.currency}`
      : s.priceOnRequest
        ? (isHe ? 'מחיר לפי בקשה' : 'Price on request')
        : ''

    const stepsHtml = s.processSteps.length > 0 ? `
<h4 style="margin-top:1rem;margin-bottom:0.5rem;font-size:0.9375rem;">${isHe ? 'מה קורה בפגישה?' : 'What happens during the appointment?'}</h4>
<ol class="process-steps" aria-label="${isHe ? 'שלבי הטיפול' : 'Process steps'}">
  ${s.processSteps.map((step) => `<li>${e(step)}</li>`).join('')}
</ol>` : ''

    const serviceFaqHtml = s.faqs.length > 0 ? `
<div class="faq-list" style="margin-top:1rem;">
  ${s.faqs.map((f) => `
  <div class="faq-item">
    <p class="faq-question">${e(f.question)}</p>
    <div class="faq-answer answer-block">${e(f.answer)}</div>
  </div>`).join('')}
</div>` : ''

    const contraHtml = s.contraindications ? `
<p style="margin-top:0.75rem;font-size:0.875rem;color:#6b7280;">
  <strong>${isHe ? 'הגבלות:' : 'Contraindications:'}</strong> ${e(s.contraindications)}
</p>` : ''

    return `
<article id="${e(s.slug)}" style="margin-bottom:3rem;padding-bottom:3rem;border-bottom:1px solid var(--color-border);">
  <h2>${isHe ? `מה כולל ${s.name}?` : `What is included in ${s.name}?`}</h2>
  <p class="service-meta">${s.durationMinutes} ${isHe ? 'דקות' : 'min'}${priceStr ? ' · ' + priceStr : ''}</p>
  <div class="answer-block"><p>${e(s.description)}</p></div>
  ${s.whoFor ? `<p style="margin-top:0.75rem;font-size:0.9375rem;"><strong>${isHe ? 'מתאים ל:' : 'Ideal for:'}</strong> ${e(s.whoFor)}</p>` : ''}
  ${stepsHtml}
  ${serviceFaqHtml}
  ${contraHtml}
  <p style="margin-top:1.25rem;">
    <a class="cta-btn" href="${waLink(biz.phone)}" rel="noopener" style="display:inline-flex;align-items:center;gap:0.5rem;font-size:0.9375rem;padding:0.75rem 1.5rem;">
      ${isHe ? `הזמינו ${s.name}` : `Book ${s.name}`}
    </a>
  </p>
</article>`
  }).join('')

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

  const serviceJsonLd = buildServiceSchemas(schema.services, biz.name, biz.city)
  const jsonLdBlocks: object[] = [
    buildLocalBusinessSchema(schema, siteUrl),
    buildWebPageSchema(title, canonical, siteUrl, description, schema.generatedAt),
    buildBreadcrumbSchema([{ name: biz.name, url: siteUrl }, { name: isHe ? 'שירותים' : 'Services', url: canonical }]),
    buildSpeakableSchema(),
    ...serviceJsonLd,
  ]

  return pageShell({ title, description, canonical, siteUrl, schema, css, jsonLdBlocks, bodyContent, dir, lang, navLinks, currentPath: '/services/' })
}

// ── FAQ page ──────────────────────────────────────────────────────────────────

function renderFaqPage(schema: SiteSchema, siteUrl: string, css: string, dir: 'rtl' | 'ltr', navLinks: NavLink[]): string {
  const biz = schema.business
  const lang = schema.language
  const isHe = lang === 'he'

  const title = truncate(`${isHe ? 'שאלות נפוצות' : 'FAQ'} — ${biz.name}`, 60)
  const description = truncate(
    isHe ? `תשובות לשאלות הנפוצות ביותר על ${biz.name}.` : `Answers to the most common questions about ${biz.name}.`,
    155,
  )
  const canonical = siteUrl + '/faq/'

  const topics: Array<{ key: FaqEntry['topic']; label: string }> = [
    { key: 'services', label: isHe ? 'שאלות על השירותים' : 'Questions about our services' },
    { key: 'pricing', label: isHe ? 'שאלות על מחירים' : 'Questions about pricing' },
    { key: 'booking', label: isHe ? 'שאלות על הזמנה וביטול' : 'Questions about booking & cancellation' },
    { key: 'location', label: isHe ? 'שאלות על מיקום ושעות' : 'Questions about location & hours' },
    { key: 'policy', label: isHe ? 'שאלות על מדיניות' : 'Policy questions' },
    { key: 'general', label: isHe ? 'שאלות כלליות' : 'General questions' },
  ]

  // All service-specific FAQs aggregated
  const allFaqs: FaqEntry[] = [...schema.faqs]
  for (const s of schema.services) {
    for (const f of s.faqs) {
      allFaqs.push({ question: f.question, answer: f.answer, topic: 'services', serviceSlug: s.slug })
    }
  }

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

  const bodyContent = `
<section class="section-surface" style="padding-top:2.5rem;padding-bottom:1rem;">
  <div class="container">
    <h1>${e(isHe ? `שאלות נפוצות — ${biz.name}` : `Frequently Asked Questions — ${biz.name}`)}</h1>
    <div class="answer-block"><p>${e(description)}</p></div>
  </div>
</section>
${bodyFaqHtml}
<section class="cta-section section-dark" aria-label="${isHe ? 'הזמנה' : 'Booking'}">
  <div class="container">
    <h2>${isHe ? 'לא מצאתם תשובה?' : "Didn't find your answer?"}</h2>
    <p class="answer-block">${isHe ? 'שלחו הודעה ישירה בוואטסאפ ונענה בהקדם.' : 'Send us a direct WhatsApp message and we\'ll reply quickly.'}</p>
    <a class="cta-btn-outline" href="${waLink(biz.phone)}" rel="noopener">
      ${isHe ? 'שאלו אותנו בוואטסאפ' : 'Ask us on WhatsApp'}
    </a>
  </div>
</section>`

  const jsonLdBlocks: object[] = [
    buildLocalBusinessSchema(schema, siteUrl),
    buildWebPageSchema(title, canonical, siteUrl, description, schema.generatedAt),
    buildBreadcrumbSchema([{ name: biz.name, url: siteUrl }, { name: isHe ? 'שאלות נפוצות' : 'FAQ', url: canonical }]),
    buildFaqPageSchema(allFaqs),
    buildSpeakableSchema(),
  ]

  return pageShell({ title, description, canonical, siteUrl, schema, css, jsonLdBlocks, bodyContent, dir, lang, navLinks, currentPath: '/faq/' })
}

// ── Contact page ──────────────────────────────────────────────────────────────

function renderContactPage(schema: SiteSchema, siteUrl: string, css: string, dir: 'rtl' | 'ltr', navLinks: NavLink[]): string {
  const biz = schema.business
  const lang = schema.language
  const isHe = lang === 'he'

  const title = truncate(`${isHe ? 'הזמנה וצור קשר' : 'Book & Contact'} — ${biz.name}`, 60)
  const description = truncate(
    isHe ? `הזמינו תור ב-${biz.name} דרך וואטסאפ. ${biz.address ? 'כתובת: ' + biz.address + ', ' + biz.city + '.' : ''}` :
      `Book an appointment at ${biz.name} via WhatsApp.${biz.address ? ' Address: ' + biz.address + ', ' + biz.city + '.' : ''}`,
    155,
  )
  const canonical = siteUrl + '/contact/'

  const hoursHtml = biz.openingHours.length > 0 ? `
<section class="section-surface" aria-labelledby="hours-heading">
  <div class="container">
    <h2 id="hours-heading">${isHe ? `מתי ${biz.name} פתוח?` : `When is ${biz.name} open?`}</h2>
    <div class="answer-block"><p>${isHe ? 'שעות הפעילות:' : 'Opening hours:'}</p></div>
    <table class="hours-table">
      <tbody>
        ${biz.openingHours.map((h) => `
        <tr>
          <td><time>${e(h.dayOfWeek.join(', '))}</time></td>
          <td><time>${e(h.opens)}</time> – <time>${e(h.closes)}</time></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</section>` : ''

  const locationHtml = (biz.address ?? biz.city) ? `
<section class="section-light" aria-labelledby="location-heading">
  <div class="container">
    <h2 id="location-heading">${isHe ? `איפה נמצא ${biz.name}?` : `Where is ${biz.name} located?`}</h2>
    <div class="contact-block">
      <address>
        <strong>${e(biz.name)}</strong><br>
        ${biz.address ? e(biz.address) + '<br>' : ''}
        ${e(biz.city)}
        ${biz.serviceArea.length > 1 ? `<br><small>${isHe ? 'אזורי שירות: ' : 'Service area: '}${e(biz.serviceArea.join(', '))}</small>` : ''}
      </address>
    </div>
  </div>
</section>` : ''

  const bodyContent = `
<section class="section-surface" style="padding-top:2.5rem;padding-bottom:1rem;">
  <div class="container">
    <h1>${isHe ? `הזמנת תור ב-${biz.name}` : `Book an Appointment at ${biz.name}`}</h1>
  </div>
</section>
<section class="section-light" aria-labelledby="book-heading">
  <div class="container">
    <h2 id="book-heading">${isHe ? `איך מזמינים תור ב-${biz.name}?` : `How do I book with ${biz.name}?`}</h2>
    <div class="answer-block">
      <p>${isHe ? `שלחו הודעה ל-${biz.name} דרך וואטסאפ — הצוות שלנו יחזור אליכם תוך זמן קצר לאשר את התור.` :
        `Send a WhatsApp message to ${biz.name} — our team will reply quickly to confirm your appointment.`}</p>
    </div>
    <p style="margin-top:1.25rem;">
      <a class="cta-btn" href="${waLink(biz.phone)}" rel="noopener" style="display:inline-flex;align-items:center;gap:0.5rem;">
        ${WA_ICON_SVG}
        ${isHe ? 'הזמינו דרך וואטסאפ' : 'Book via WhatsApp'}
      </a>
    </p>
  </div>
</section>
${hoursHtml}
${locationHtml}`

  const jsonLdBlocks: object[] = [
    buildLocalBusinessSchema(schema, siteUrl),
    buildWebPageSchema(title, canonical, siteUrl, description, schema.generatedAt),
    buildBreadcrumbSchema([{ name: biz.name, url: siteUrl }, { name: isHe ? 'צור קשר' : 'Contact', url: canonical }]),
    buildSpeakableSchema(),
  ]

  return pageShell({ title, description, canonical, siteUrl, schema, css, jsonLdBlocks, bodyContent, dir, lang, navLinks, currentPath: '/contact/' })
}

// ── About page ────────────────────────────────────────────────────────────────

function renderAboutPage(schema: SiteSchema, siteUrl: string, css: string, dir: 'rtl' | 'ltr', navLinks: NavLink[]): string | null {
  const biz = schema.business
  const lang = schema.language
  const isHe = lang === 'he'

  if (!biz.practitionerName) return null

  const title = truncate(`${isHe ? 'אודות' : 'About'} ${biz.practitionerName} — ${biz.name}`, 60)
  const description = truncate(
    biz.practitionerBio ?? (isHe ? `${biz.practitionerName} — ${biz.practitionerTitle ?? ''} ב-${biz.name}.` : `${biz.practitionerName} — ${biz.practitionerTitle ?? ''} at ${biz.name}.`),
    155,
  )
  const canonical = siteUrl + '/about/'

  const personSchema = buildPersonSchema(schema, siteUrl)

  const credHtml = biz.credentials.length > 0 ? `
<h3>${isHe ? 'הסמכות ורקע מקצועי' : 'Credentials & Background'}</h3>
<ul class="credentials-list">
  ${biz.credentials.map((c) => `<li>${e(c)}</li>`).join('')}
</ul>` : ''

  const bodyContent = `
<section class="section-light" style="padding-top:2.5rem;">
  <div class="container">
    <h1>${isHe ? `אודות ${biz.practitionerName}` : `About ${biz.practitionerName}`}</h1>
    <div class="practitioner-card">
      <div class="practitioner-bio">
        ${biz.practitionerTitle ? `<p style="font-weight:600;color:var(--color-primary);margin-bottom:0.75rem;">${e(biz.practitionerTitle)}</p>` : ''}
        ${biz.practitionerBio ? `<div class="answer-block"><p>${e(biz.practitionerBio)}</p></div>` : ''}
        ${credHtml}
      </div>
    </div>
  </div>
</section>
<section class="cta-section section-dark" aria-label="${isHe ? 'הזמנה' : 'Booking'}">
  <div class="container">
    <h2>${isHe ? `הזמינו תור עם ${biz.practitionerName}` : `Book with ${biz.practitionerName}`}</h2>
    <p class="answer-block">${isHe ? 'ניתן להזמין ישירות דרך וואטסאפ.' : 'Book directly via WhatsApp.'}</p>
    <p style="margin-top:1.25rem;">
      <a class="cta-btn" href="${waLink(biz.phone)}" rel="noopener" style="display:inline-flex;align-items:center;gap:0.5rem;">
        ${isHe ? 'הזמינו עכשיו' : 'Book now'}
      </a>
    </p>
  </div>
</section>`

  const jsonLdBlocks: object[] = [
    buildLocalBusinessSchema(schema, siteUrl),
    buildWebPageSchema(title, canonical, siteUrl, description, schema.generatedAt),
    buildBreadcrumbSchema([{ name: biz.name, url: siteUrl }, { name: isHe ? 'אודות' : 'About', url: canonical }]),
    buildSpeakableSchema(),
    ...(personSchema ? [personSchema] : []),
  ]

  return pageShell({ title, description, canonical, siteUrl, schema, css, jsonLdBlocks, bodyContent, dir, lang, navLinks, currentPath: '/about/' })
}

// ── Main render entry point ───────────────────────────────────────────────────

export function renderSite(schema: SiteSchema, siteUrl: string): RenderedSite {
  const palette = resolvePalette(schema.style.palette)
  const dir: 'rtl' | 'ltr' = schema.language === 'he' ? 'rtl' : 'ltr'
  const isHe = schema.language === 'he'
  const css = buildCSS(schema.style.variant, palette, dir)

  const navLinks: NavLink[] = [
    { href: siteUrl + '/', path: '/', label: isHe ? 'בית' : 'Home' },
    { href: siteUrl + '/services/', path: '/services/', label: isHe ? 'שירותים' : 'Services' },
    { href: siteUrl + '/faq/', path: '/faq/', label: 'FAQ' },
    ...(schema.business.practitionerName ? [{ href: siteUrl + '/about/', path: '/about/', label: isHe ? 'אודות' : 'About' }] : []),
    { href: siteUrl + '/contact/', path: '/contact/', label: isHe ? 'צור קשר' : 'Contact' },
  ]

  const result: RenderedSite = {
    'index.html': renderHomepage(schema, siteUrl, css, dir, navLinks),
    'services/index.html': renderServicesPage(schema, siteUrl, css, dir, navLinks),
    'faq/index.html': renderFaqPage(schema, siteUrl, css, dir, navLinks),
    'contact/index.html': renderContactPage(schema, siteUrl, css, dir, navLinks),
  }

  const aboutHtml = renderAboutPage(schema, siteUrl, css, dir, navLinks)
  if (aboutHtml) result['about/index.html'] = aboutHtml

  return result
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…'
}
