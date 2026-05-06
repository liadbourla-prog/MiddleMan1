import type { Palette } from './palettes.js'

export type StyleVariant = 'minimal' | 'bold' | 'professional'

export function buildCSS(variant: StyleVariant, palette: Palette, dir: 'ltr' | 'rtl'): string {
  const vars = `
    --color-primary: ${palette.primary};
    --color-accent: ${palette.accent};
    --color-surface: ${palette.surface};
    --color-text: ${palette.text};
    --color-border: ${palette.border};
    --color-accent-text: ${palette.accentText};
  `

  const base = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root { ${vars} }
html { font-size: 16px; scroll-behavior: smooth; }
body {
  font-family: ${variantFont(variant)};
  color: var(--color-text);
  background: #ffffff;
  line-height: 1.6;
  direction: ${dir};
}
a { color: var(--color-primary); text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; height: auto; display: block; }

/* Layout */
.container { max-width: 1100px; margin: 0 auto; padding: 0 1.5rem; }
header {
  background: var(--color-primary);
  color: #fff;
  padding: ${variantHeaderPadding(variant)};
}
.header-inner { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; }
.site-name { font-size: ${variantH1Size(variant)}; font-weight: 700; color: #fff; letter-spacing: -0.02em; }
.site-tagline { font-size: 0.95rem; opacity: 0.85; margin-top: 0.25rem; }
nav a { color: #fff; opacity: 0.85; margin-${dir === 'rtl' ? 'right' : 'left'}: 1.25rem; font-size: 0.95rem; }
nav a:hover { opacity: 1; text-decoration: none; }

/* Hero */
.hero {
  background: var(--color-primary);
  color: #fff;
  padding: ${variantHeroPadding(variant)};
  text-align: center;
}
.hero h1 { font-size: clamp(1.75rem, 5vw, ${variantHeroH1(variant)}); font-weight: 700; line-height: 1.2; margin-bottom: 1rem; }
.hero .lead { font-size: 1.125rem; opacity: 0.9; max-width: 640px; margin: 0 auto 1.75rem; }
.hero .cta-btn {
  display: inline-flex; align-items: center; gap: 0.5rem;
  background: var(--color-accent); color: var(--color-accent-text);
  padding: 0.875rem 2rem; border-radius: ${variantRadius(variant)};
  font-weight: 700; font-size: 1rem;
}
.hero .cta-btn:hover { opacity: 0.92; text-decoration: none; }

/* Sections */
section { padding: ${variantSectionPadding(variant)} 0; }
section:nth-child(even) { background: var(--color-surface); }
h2 { font-size: ${variantH2Size(variant)}; font-weight: 700; color: var(--color-primary); margin-bottom: 1.25rem; line-height: 1.25; }
h3 { font-size: 1.125rem; font-weight: 600; color: var(--color-primary); margin-bottom: 0.5rem; }

/* Answer blocks */
.answer-block { font-size: 1rem; line-height: 1.7; margin-bottom: 1rem; }
.answer-block p { margin-bottom: 0.75rem; }

/* Service cards */
.services-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.5rem; margin-top: 1.5rem; }
.service-card {
  border: 1px solid var(--color-border);
  border-radius: ${variantRadius(variant)};
  padding: 1.5rem;
  background: #fff;
}
.service-card h3 { color: var(--color-primary); }
.service-meta { font-size: 0.875rem; color: #6b7280; margin: 0.5rem 0; }
.service-price { font-weight: 700; color: var(--color-primary); font-size: 1.0625rem; }

/* Process steps */
.process-steps { margin: 1rem 0; padding: 0; list-style: none; counter-reset: steps; }
.process-steps li {
  counter-increment: steps;
  display: flex; gap: 1rem; align-items: flex-start;
  margin-bottom: 0.875rem; font-size: 0.9375rem;
}
.process-steps li::before {
  content: counter(steps);
  background: var(--color-accent); color: var(--color-accent-text);
  min-width: 1.75rem; height: 1.75rem;
  border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 0.875rem; flex-shrink: 0;
}

/* FAQ */
.faq-list { margin-top: 1.25rem; }
.faq-item { border-bottom: 1px solid var(--color-border); padding: 1.25rem 0; }
.faq-item:last-child { border-bottom: none; }
.faq-question { font-weight: 600; font-size: 1rem; color: var(--color-primary); margin-bottom: 0.5rem; }
.faq-answer { font-size: 0.9375rem; line-height: 1.7; color: #374151; }

/* Trust section */
.trust-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1.25rem; margin-top: 1.5rem; }
.trust-item { display: flex; align-items: flex-start; gap: 0.75rem; }
.trust-icon { font-size: 1.25rem; flex-shrink: 0; }

/* CTA section */
.cta-section { background: var(--color-primary); color: #fff; text-align: center; padding: 4rem 0; }
.cta-section h2 { color: #fff; }
.cta-section p { opacity: 0.9; margin-bottom: 1.5rem; }
.cta-btn-outline {
  display: inline-flex; align-items: center; gap: 0.5rem;
  border: 2px solid var(--color-accent); color: var(--color-accent);
  padding: 0.875rem 2rem; border-radius: ${variantRadius(variant)};
  font-weight: 700; font-size: 1rem;
}
.cta-btn-outline:hover { background: var(--color-accent); color: var(--color-accent-text); text-decoration: none; }

/* Hours table */
.hours-table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
.hours-table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--color-border); }
.hours-table td:first-child { font-weight: 600; color: var(--color-primary); }

/* Contact */
.contact-block { background: var(--color-surface); border-radius: ${variantRadius(variant)}; padding: 2rem; margin-top: 1.5rem; }
address { font-style: normal; line-height: 1.8; }

/* Footer */
footer {
  background: var(--color-primary);
  color: rgba(255,255,255,0.8);
  padding: 2.5rem 0;
  font-size: 0.875rem;
}
footer address { color: rgba(255,255,255,0.7); }
footer a { color: rgba(255,255,255,0.85); }
.footer-inner { display: flex; flex-wrap: wrap; gap: 2rem; justify-content: space-between; }

/* WhatsApp sticky CTA */
.wa-cta {
  position: fixed;
  bottom: 1.5rem;
  ${dir === 'rtl' ? 'left' : 'right'}: 1.5rem;
  width: 3.5rem; height: 3.5rem;
  background: #25D366;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  z-index: 9999;
  transition: transform 0.2s;
}
.wa-cta:hover { transform: scale(1.08); text-decoration: none; }
.wa-cta svg { width: 2rem; height: 2rem; fill: #fff; }

/* About page */
.practitioner-card { display: flex; gap: 2rem; align-items: flex-start; flex-wrap: wrap; margin-top: 1.5rem; }
.practitioner-bio { flex: 1; min-width: 240px; }
.credentials-list { margin-top: 1rem; padding: ${dir === 'rtl' ? '0 1.5rem 0 0' : '0 0 0 1.5rem'}; }
.credentials-list li { margin-bottom: 0.5rem; font-size: 0.9375rem; }

/* Responsive */
@media (max-width: 640px) {
  .services-grid, .trust-grid { grid-template-columns: 1fr; }
  .hero { padding: 3rem 0; }
  .hero h1 { font-size: 1.75rem; }
  .header-inner { flex-direction: column; align-items: flex-start; }
  nav { margin-top: 0.5rem; }
  nav a { margin-${dir === 'rtl' ? 'right' : 'left'}: 0; margin-${dir === 'rtl' ? 'left' : 'right'}: 1rem; }
}
`
  return base
}

function variantFont(v: StyleVariant): string {
  switch (v) {
    case 'minimal':      return 'system-ui, -apple-system, "Segoe UI", sans-serif'
    case 'bold':         return '"DM Sans", system-ui, -apple-system, sans-serif'
    case 'professional': return 'Georgia, "Times New Roman", serif'
  }
}
function variantH1Size(v: StyleVariant): string {
  return v === 'bold' ? '1.75rem' : '1.5rem'
}
function variantH2Size(v: StyleVariant): string {
  return v === 'bold' ? '1.875rem' : '1.5rem'
}
function variantHeroH1(v: StyleVariant): string {
  return v === 'bold' ? '3.5rem' : '2.75rem'
}
function variantHeaderPadding(v: StyleVariant): string {
  return v === 'minimal' ? '1rem 0' : '1.25rem 0'
}
function variantHeroPadding(v: StyleVariant): string {
  return v === 'bold' ? '6rem 0' : '4.5rem 0'
}
function variantSectionPadding(v: StyleVariant): string {
  return v === 'minimal' ? '4rem' : v === 'bold' ? '5rem' : '4.5rem'
}
function variantRadius(v: StyleVariant): string {
  return v === 'minimal' ? '0.375rem' : v === 'bold' ? '0.75rem' : '0.25rem'
}
