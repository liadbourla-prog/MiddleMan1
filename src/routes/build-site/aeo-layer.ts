import type { SiteSchema, ServiceEntry, FaqEntry } from '../../skills/website-builder/site-schema.js'

// ── JSON-LD generators ────────────────────────────────────────────────────────

export function buildLocalBusinessSchema(schema: SiteSchema, siteUrl: string): object {
  const biz = schema.business

  const openingHours = biz.openingHours.map((h) => ({
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: h.dayOfWeek.map((d) => `https://schema.org/${d}`),
    opens: h.opens,
    closes: h.closes,
  }))

  const sameAs: string[] = []
  if (biz.googleBusinessProfileUrl) sameAs.push(biz.googleBusinessProfileUrl)

  const priceRange = schema.services.length > 0
    ? buildPriceRange(schema.services, schema.business.city)
    : undefined

  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: biz.name,
    description: biz.description,
    url: siteUrl,
    telephone: biz.phone,
    ...(biz.address ? { address: { '@type': 'PostalAddress', streetAddress: biz.address, addressLocality: biz.city } } : {}),
    areaServed: biz.serviceArea.length > 0 ? biz.serviceArea : [biz.city],
    openingHoursSpecification: openingHours,
    ...(priceRange ? { priceRange } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
    ...(biz.foundedYear ? { foundingDate: String(biz.foundedYear) } : {}),
  }
}

export function buildFaqPageSchema(faqs: FaqEntry[]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  }
}

export function buildServiceSchemas(services: ServiceEntry[], businessName: string, city: string): object[] {
  return services.map((s) => ({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: s.name,
    description: s.description,
    provider: { '@type': 'LocalBusiness', name: businessName },
    areaServed: city,
    ...(s.price !== null
      ? { offers: { '@type': 'Offer', price: String(s.price), priceCurrency: s.currency } }
      : s.priceOnRequest
        ? { offers: { '@type': 'Offer', availability: 'https://schema.org/InStock', description: 'Price on request' } }
        : {}),
    ...(s.processSteps.length > 0 ? {
      serviceOutput: {
        '@type': 'HowTo',
        name: `What happens during ${s.name}`,
        step: s.processSteps.map((text, i) => ({
          '@type': 'HowToStep',
          position: i + 1,
          text,
        })),
      },
    } : {}),
  }))
}

export function buildPersonSchema(schema: SiteSchema, siteUrl: string): object | null {
  const biz = schema.business
  if (!biz.practitionerName) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: biz.practitionerName,
    ...(biz.practitionerTitle ? { jobTitle: biz.practitionerTitle } : {}),
    worksFor: { '@type': 'LocalBusiness', name: biz.name, url: siteUrl },
    ...(biz.credentials.length > 0 ? { hasCredential: biz.credentials.map((c) => ({ '@type': 'EducationalOccupationalCredential', credentialCategory: c })) } : {}),
  }
}

export function buildWebPageSchema(pageTitle: string, pageUrl: string, siteUrl: string, description: string, generatedAt: string): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: pageTitle,
    url: pageUrl,
    isPartOf: { '@type': 'WebSite', url: siteUrl },
    description,
    dateModified: generatedAt,
  }
}

export function buildBreadcrumbSchema(items: Array<{ name: string; url: string }>): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  }
}

export function buildSpeakableSchema(): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    speakable: {
      '@type': 'SpeakableSpecification',
      cssSelector: ['.answer-block', '.faq-answer', '.hero .lead'],
    },
  }
}

export function serializeJsonLd(obj: object): string {
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`
}

// ── llms.txt ──────────────────────────────────────────────────────────────────

export function buildLlmsTxt(schema: SiteSchema): string {
  const biz = schema.business
  const lines: string[] = []

  lines.push(`# ${biz.name}`)
  lines.push('')
  lines.push(`> ${biz.tagline} — ${biz.category} in ${biz.city}`)
  lines.push('')
  lines.push(biz.description)
  lines.push('')

  lines.push('## Services')
  for (const s of schema.services) {
    const priceStr = s.price !== null ? `${s.price} ${s.currency}` : s.priceOnRequest ? 'price on request' : ''
    lines.push(`- ${s.name}: ${s.durationMinutes}min${priceStr ? ' · ' + priceStr : ''} · ${s.description}`)
  }
  lines.push('')

  if (biz.openingHours.length > 0) {
    lines.push('## Hours')
    for (const h of biz.openingHours) {
      lines.push(`- ${h.dayOfWeek.join(', ')}: ${h.opens}–${h.closes}`)
    }
    lines.push('')
  }

  lines.push('## Booking')
  lines.push(`- Book via WhatsApp: https://wa.me/${biz.phone.replace(/\D/g, '')}`)
  lines.push('')

  if (biz.address ?? biz.serviceArea.length > 0) {
    lines.push('## Location')
    if (biz.address) lines.push(`- Address: ${biz.address}, ${biz.city}`)
    if (biz.serviceArea.length > 0) lines.push(`- Service area: ${biz.serviceArea.join(', ')}`)
    lines.push('')
  }

  if (schema.faqs.length > 0) {
    lines.push('## FAQs')
    for (const f of schema.faqs) {
      lines.push(`**Q: ${f.question}**`)
      lines.push(`A: ${f.answer}`)
      lines.push('')
    }
  }

  return lines.join('\n')
}

// ── robots.txt ────────────────────────────────────────────────────────────────

export function buildRobotsTxt(siteUrl: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    '',
    'User-agent: GPTBot',
    'Allow: /',
    '',
    'User-agent: ClaudeBot',
    'Allow: /',
    '',
    'User-agent: Google-Extended',
    'Allow: /',
    '',
    'User-agent: PerplexityBot',
    'Allow: /',
    '',
    'User-agent: Applebot',
    'Allow: /',
    '',
    `Sitemap: ${siteUrl}/sitemap.xml`,
  ].join('\n')
}

// ── sitemap.xml ───────────────────────────────────────────────────────────────

export function buildSitemapXml(pages: Array<{ url: string; lastmod: string }>): string {
  const items = pages
    .map((p) => `  <url>\n    <loc>${escXml(p.url)}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n  </url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPriceRange(services: ServiceEntry[], _city: string): string | undefined {
  const prices = services.filter((s) => s.price !== null).map((s) => s.price as number)
  if (prices.length === 0) return undefined
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const currency = services[0]?.currency ?? 'ILS'
  if (min === max) return `${min} ${currency}`
  return `${min}–${max} ${currency}`
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
