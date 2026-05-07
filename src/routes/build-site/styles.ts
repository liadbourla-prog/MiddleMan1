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
