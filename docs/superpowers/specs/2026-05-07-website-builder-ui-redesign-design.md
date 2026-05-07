# Website Builder — Frontend UI Redesign

**Date:** 2026-05-07  
**Scope:** `src/routes/build-site/styles.ts` + `src/routes/build-site/renderer.ts` only  
**AEO constraint:** Zero regressions to any AEO-critical element (see §8)  
**No changes to:** `aeo-layer.ts`, `site-schema.ts`, any skill file, DB schema, SiteSchema interface

---

## 1. Goals

- Make all 3 style variants (minimal / bold / professional) look dramatically more polished and visually distinct from each other
- Fix the header/hero visual bleed (both currently `--color-primary` dark, reads as one block)
- Introduce a proper design token system (type scale, spacing scale, shadow levels)
- Implement variant-specific service card layouts
- Improve section rhythm, FAQ visual treatment, trust section, footer, and mobile responsiveness
- Preserve every AEO signal exactly — no heading hierarchy changes, no class removals, no JS additions

---

## 2. Design Token System

Add a shared token layer at the top of `buildCSS()`, before variant overrides. All component styles reference these tokens. Variants override them as needed.

### Type scale
```css
--text-xs:      0.75rem
--text-sm:      0.875rem
--text-base:    1rem
--text-lg:      1.125rem
--text-xl:      1.25rem
--text-2xl:     1.5rem
--text-3xl:     2rem
--text-display: clamp(2.25rem, 5vw, var(--hero-h1-max, 3rem))
```

### Font stack tokens (set per variant, used throughout)
```css
--font-body:    system-ui, -apple-system, sans-serif  /* same all variants */
--font-heading: /* variant-specific — see table below */
--heading-weight: /* variant-specific */
```

### Spacing scale
```css
--space-1:  0.25rem   --space-2:  0.5rem    --space-3:  0.75rem
--space-4:  1rem      --space-6:  1.5rem    --space-8:  2rem
--space-12: 3rem      --space-16: 4rem      --space-24: 6rem
```

### Shadow levels
```css
--shadow-sm: 0 1px 3px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.05)
--shadow-md: 0 4px 16px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06)
--shadow-lg: 0 10px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)
```

### Per-variant overrides

| Token | `minimal` | `bold` | `professional` |
|---|---|---|---|
| `--radius` | `0.5rem` | `0.875rem` | `0.25rem` |
| `--heading-weight` | `700` | `800` | `700` |
| `--font-heading` | `system-ui, -apple-system, sans-serif` | `system-ui, -apple-system, sans-serif` | `Georgia, "Times New Roman", serif` |
| `--font-body` | `system-ui, -apple-system, sans-serif` | `system-ui, -apple-system, sans-serif` | `system-ui, -apple-system, sans-serif` |
| `--section-padding` | `5rem` | `6rem` | `5.5rem` |
| `--hero-padding` | `5rem 0` | `7rem 0` | `5.5rem 0` |
| `--hero-h1-max` | `3rem` | `3.5rem` | `2.75rem` |

> **Note on professional body font:** Reverting full-body Georgia to system-ui. Georgia is used for headings only in `professional` — body text in serif was heavy and hard to read at small sizes.

---

## 3. Navigation

The header remains a distinct dark strip (`--color-primary`, `1rem 0` padding) above the hero — unchanged visually except:

- Active nav link gets `aria-current="page"` attribute (renderer already knows `currentPath`, emits conditionally)
- CSS rule: `nav a[aria-current="page"] { opacity: 1; border-bottom: 2px solid var(--color-accent); padding-bottom: 2px; }`
- All other nav links: `opacity: 0.75`, `hover: opacity: 1`

**AEO impact:** `aria-current="page"` improves accessibility semantics — net positive.

---

## 4. Hero Section — Split Layout

Replaces the current single-column centred hero. Both variants keep `--color-primary` as the background; the visual separation comes from the right panel gradient.

### HTML structure (rendered by `renderHomepage`)

```html
<section class="hero" aria-label="Hero">
  <div class="container">
    <div class="hero-inner">

      <!-- Left panel: text + CTA -->
      <div class="hero-text">
        <p class="hero-eyebrow">[category] · [city]</p>
        <h1>[title]</h1>
        <p class="lead answer-block">[description]</p>
        <a class="cta-btn" href="https://wa.me/[phone]" rel="noopener">
          [WA_ICON_SVG]
          Book via WhatsApp
        </a>
      </div>

      <!-- Right panel: service highlights (decorative, hidden on mobile) -->
      <div class="hero-panel" aria-hidden="true">
        <!-- 2–3 service highlight cards from schema.services -->
        <div class="hero-service-card">
          <span class="hero-service-name">[service.name]</span>
          <span class="hero-service-meta">[price or "Price on request"]</span>
        </div>
        <!-- ... -->
      </div>

    </div>
  </div>
</section>
```

### CSS

```css
.hero-inner {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: var(--space-12);
  align-items: center;
}
.hero-text { /* left panel */ }
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
  color: rgba(255,255,255,0.75);
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
.hero-service-name {
  font-size: var(--text-sm);
  font-weight: 600;
  color: rgba(255,255,255,0.9);
}
.hero-service-meta {
  font-size: var(--text-xs);
  color: rgba(255,255,255,0.5);
}
/* WA CTA button */
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
.cta-btn svg { width: 1.25rem; height: 1.25rem; fill: #fff; }
.cta-btn:hover { opacity: 0.92; text-decoration: none; }
```

### Responsive collapse (≤768px)
```css
@media (max-width: 768px) {
  .hero-inner { grid-template-columns: 1fr; }
  .hero-panel { display: none; } /* decorative only — content already in body */
  .hero { text-align: center; }
  .hero .lead { margin-left: auto; margin-right: auto; }
}
```

> **AEO note:** `.hero-panel` carries `aria-hidden="true"` and is hidden on mobile via `display:none`. The service names in the panel are purely decorative duplicates — the canonical service content lives in the services section and services page. No content is lost.

---

## 5. Section Rhythm

Replace `section:nth-child(even)` (fragile) with explicit CSS classes emitted by the renderer.

### Classes

| Class | Background | Text |
|---|---|---|
| `.section-light` | `#ffffff` | `--color-text` |
| `.section-surface` | `var(--color-surface)` | `--color-text` |
| `.section-dark` | `var(--color-primary)` | `#ffffff` |

### Assignment pattern (per page, applied in `renderer.ts`)

**Homepage:** hero (always dark) → services (surface) → trust (light) → FAQ (surface) → CTA (dark)  
**Services:** intro (surface) → service blocks (light)  
**FAQ:** intro (surface) → each topic group alternates light/surface → CTA (dark)  
**Contact:** intro (surface) → book (light) → hours (surface) → location (light)  
**About:** intro (light) → credentials (surface) → booking CTA (dark)

---

## 6. Service Card Layouts — Variant-Driven

The renderer checks `schema.style.variant` and emits a different HTML structure. All three share the same CSS class namespace; variant-specific CSS rules handle the visual differences.

### `bold` — Feature blocks (default, Option B)

```html
<div class="services-list">
  <article class="service-feature" style="--feature-icon: '📱'">
    <div class="service-feature-header">
      <span class="service-feature-icon" aria-hidden="true"></span>
      <h3>[name]</h3>
    </div>
    <p class="service-meta">[duration] · [price]</p>
    <div class="answer-block"><p>[description]</p></div>
    <a class="service-link" href="[waLink]">Book [name] →</a>
  </article>
  <hr class="service-divider">
  <!-- ... -->
</div>
```

Icon mapping by service index: `['📱', '🧠', '🌐', '✂️', '💆', '🏋️', '📸', '🎵']` — cycles if more services than icons.

```css
.services-list { display: flex; flex-direction: column; }
.service-feature {
  padding: var(--space-8) 0;
  border-left: 4px solid var(--color-accent);
  padding-left: var(--space-6);
}
.service-feature-header {
  display: flex; align-items: center; gap: var(--space-3);
  margin-bottom: var(--space-2);
}
.service-feature-icon::before { content: var(--feature-icon); font-size: 1.5rem; }
.service-divider { border: none; border-top: 1px solid var(--color-border); margin: 0; }
.service-link { font-size: var(--text-sm); font-weight: 600; color: var(--color-accent); }
```

### `minimal` — Elevated cards (Option A)

```html
<div class="services-grid">
  <article class="service-card">
    <div class="service-card-header">
      <h3>[name]</h3>
      <span class="service-tag">[price or "On request"]</span>
    </div>
    <p class="service-meta">[duration]</p>
    <div class="answer-block"><p>[description]</p></div>
    <a class="service-link" href="[waLink]">Learn more →</a>
  </article>
</div>
```

```css
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
.service-card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
.service-tag {
  display: inline-block;
  font-size: var(--text-xs);
  font-weight: 700;
  padding: 0.2rem 0.5rem;
  background: var(--color-surface);
  color: var(--color-primary);
  border-radius: 999px;
}
```

### `professional` — Filled-header cards (Option C)

```html
<div class="services-grid">
  <article class="service-card-pro">
    <div class="service-card-pro-header">
      <h3>[name]</h3>
      <span class="service-meta">[price]</span>
    </div>
    <div class="service-card-pro-body">
      <div class="answer-block"><p>[description]</p></div>
      <a class="service-link" href="[waLink]">Book via WhatsApp →</a>
    </div>
  </article>
</div>
```

```css
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
.service-card-pro-header .service-meta { color: rgba(255,255,255,0.65); font-size: var(--text-sm); }
.service-card-pro-body { background: #fff; padding: var(--space-4) var(--space-6); }
```

---

## 7. FAQ Visual Treatment

Existing classes `.faq-list`, `.faq-item`, `.faq-question`, `.faq-answer` are **preserved exactly** (AEO requirement). Visual improvements are purely additive CSS:

```css
.faq-list { counter-reset: faqs; }
.faq-item {
  border-bottom: 1px solid var(--color-border);
  padding: var(--space-6) 0;
  counter-increment: faqs;
}
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
  padding-left: var(--space-8);  /* aligns with text after the counter */
  border-left: 3px solid var(--color-border);
  margin-left: calc(var(--space-8) - var(--space-4));
}
```

---

## 8. Trust Section

Replaces plain checkmark list with stat-forward cards:

```html
<div class="trust-grid">
  <!-- Years experience (if foundedYear set) -->
  <div class="trust-stat">
    <span class="trust-stat-number">[N]+</span>
    <span class="trust-stat-label">years of experience</span>
  </div>
  <!-- Credentials as pill badges -->
  <div class="trust-credentials">
    <span class="trust-pill">[credential]</span>
    <!-- ... -->
  </div>
  <!-- Service area -->
  <div class="trust-area">
    <span class="trust-icon">📍</span>
    <span>[city1], [city2], ...</span>
  </div>
</div>
```

```css
.trust-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-6);
  margin-top: var(--space-6);
}
.trust-stat {
  display: flex; flex-direction: column;
  align-items: flex-start; gap: var(--space-1);
}
.trust-stat-number {
  font-size: var(--text-3xl);
  font-weight: 800;
  color: var(--color-primary);
  line-height: 1;
}
.trust-stat-label { font-size: var(--text-sm); color: #6b7280; }
.trust-pill {
  display: inline-block;
  font-size: var(--text-xs);
  padding: 0.25rem 0.75rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-primary);
  margin: 0.2rem;
}
```

---

## 9. Footer

Three-column layout replacing current two-column:

```html
<footer>
  <div class="container">
    <div class="footer-inner">
      <!-- Col 1: NAP — <address> preserved -->
      <div class="footer-col">
        <strong class="footer-brand">[name]</strong>
        <address>...</address>  <!-- unchanged -->
      </div>
      <!-- Col 2: Navigation -->
      <div class="footer-col">
        <p class="footer-col-label">Quick links</p>
        <nav aria-label="Footer navigation">...</nav>
      </div>
      <!-- Col 3: Hours (suppressed if openingHours empty) -->
      <div class="footer-col">
        <p class="footer-col-label">Opening hours</p>
        <!-- first 2 openingHours blocks -->
      </div>
    </div>
    <div class="footer-bottom">
      <p>© [generatedAt year] [business name]</p>
    </div>
  </div>
</footer>
```

```css
.footer-inner {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: var(--space-12);
  padding-bottom: var(--space-8);
  border-bottom: 1px solid rgba(255,255,255,0.1);
}
.footer-col-label {
  font-size: var(--text-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.4);
  margin-bottom: var(--space-4);
}
.footer-bottom {
  padding-top: var(--space-4);
  font-size: var(--text-xs);
  color: rgba(255,255,255,0.35);
}
@media (max-width: 768px) {
  .footer-inner { grid-template-columns: 1fr; gap: var(--space-8); }
  .footer-col:last-child { display: none; } /* hours col */
}
```

---

## 10. Responsive Breakpoints

Three breakpoints (up from one):

| Breakpoint | Changes |
|---|---|
| `≤1100px` | Container padding increases |
| `≤768px` | Hero stacks (right panel hidden), footer 1-col, service grids 2-col |
| `≤480px` | All grids 1-col, section padding reduces to `--space-12`, nav wraps |

---

## 11. AEO Preservation — Explicit Guarantees

Every AEO-critical element is structurally unchanged:

| Element | Change | Status |
|---|---|---|
| `.answer-block` on all content paragraphs | None | ✅ |
| `.faq-answer`, `.faq-question`, `.faq-item` | CSS additions only | ✅ |
| `h1/h2/h3` hierarchy per page | None | ✅ |
| `<address>` NAP block in footer | None | ✅ |
| `aria-labelledby` on all sections | None | ✅ |
| All JSON-LD `<script>` blocks | Not touched (`aeo-layer.ts` not modified) | ✅ |
| `<title>`, `<meta>`, canonical, OG tags | Not touched | ✅ |
| `llms.txt`, `sitemap.xml`, `robots.txt` | Not touched (`aeo-layer.ts` not modified) | ✅ |
| `.hero-panel` (decorative service list) | `aria-hidden="true"`, `display:none` on mobile | ✅ |
| Zero-JS content requirement | No `<script>` tags added anywhere | ✅ |

New element: `aria-current="page"` on active nav link — accessibility improvement, net positive for AEO.

---

## 12. Files Changed

| File | Nature of change |
|---|---|
| `src/routes/build-site/styles.ts` | Full rewrite — token system, all component CSS, 3 variant overrides, 3 breakpoints |
| `src/routes/build-site/renderer.ts` | Targeted changes — split hero HTML, variant card HTML, section classes, footer 3-col, aria-current nav, copyright year |

**Files explicitly not changed:**
`aeo-layer.ts`, `palettes.ts`, `site-schema.ts`, `index.ts` (route), any file in `src/skills/`, `src/domain/`, `src/db/`, `src/shared/`
