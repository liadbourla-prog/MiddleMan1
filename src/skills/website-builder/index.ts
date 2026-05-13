import type { Skill, SkillContext, SkillOutcome } from '../../shared/skill-types.js'
import { generateSiteContent, patchSiteContent, suggestPalette, generateAddonContent, type AddonGatherInput } from './content-generator.js'
import { runFullAeoPass, formatAeoSummary, type AeoReport } from './aeo-validator.js'
import type { SiteSchema, AddonKey } from './site-schema.js'
import { SiteSchemaZod } from './site-schema.js'

// ── State ─────────────────────────────────────────────────────────────────────

interface WbsState {
  // Build flow — requirements-gather
  styleVariant?: 'minimal' | 'bold' | 'professional'
  palette?: string
  paletteHint?: string
  practitionerName?: string | null
  practitionerTitle?: string | null
  practitionerBio?: string | null
  address?: string | null
  credentials?: string[]
  foundedYear?: number | null
  googleBusinessProfileUrl?: string | null
  domainPreference?: string | null
  structureConfirmed?: boolean
  // Generated (both flows)
  siteSchema?: Record<string, unknown>
  aeoReport?: AeoReport
  previewUrl?: string
  editLoopCount?: number
  // Update flow
  isUpdateFlow?: boolean
  editRequest?: string
  // Add-ons flow (build flow only, after first manager-review approval)
  baseApproved?: boolean
  selectedAddons?: AddonKey[]
  pendingAddons?: AddonKey[]
  currentAddonKey?: AddonKey
  addonGatherState?: Partial<Record<AddonKey, { rawText: string }>>
}

type Step =
  | 'requirements-gather'
  | 'structure-confirm'
  | 'content-generate'
  | 'aeo-pass'
  | 'preview-deploy'
  | 'manager-review'
  | 'addons-menu'
  | 'addon-gather'
  | 'domain-setup'
  | 'deploy'
  | 'complete'
  | 'edit-request'
  | 'content-patch'

// ── Intent helpers ────────────────────────────────────────────────────────────

// Use (?:\b|$) instead of \b alone — Hebrew chars are \W so \b doesn't match
// at end of a Hebrew-only word. (?:\b|$) handles both ASCII and Hebrew endings.
function isCancelText(text: string): boolean {
  return /^(stop|cancel|never mind|quit|עצור|בטל|די|הפסק|ביטול)(?:\b|$)/i.test(text.trim())
}

function isApproveText(text: string): boolean {
  return /^(approve[d]?|yes|ok|good|great|looks? good|perfect|continue|proceed|אשר|אישור|טוב|מעולה|כן|אוקיי|מאושר|נראה טוב|המשך)(?:\b|$)/i.test(text.trim())
}

function isSkipText(text: string): boolean {
  return /^(skip|next|דלג|הבא|pass)(?:\b|$)/i.test(text.trim())
}

// ── Add-on helpers ────────────────────────────────────────────────────────────

const ADDON_INFO: Record<AddonKey, { num: number; labelEn: string; labelHe: string; descEn: string; descHe: string }> = {
  bookingWidget:  { num: 1, labelEn: 'Booking Calendar',  labelHe: 'יומן הזמנות',   descEn: 'live availability widget powered by your PA calendar', descHe: 'ווידג׳ט זמינות חי, מחובר ליומן ה-PA שלכם' },
  paymentOptions: { num: 2, labelEn: 'Payment Options',   labelHe: 'אמצעי תשלום',   descEn: 'accepted payment methods and links',                  descHe: 'שיטות תשלום וקישורים' },
  memberships:    { num: 3, labelEn: 'Memberships',       labelHe: 'מנויים',         descEn: 'subscription plans and tier comparison',              descHe: 'תוכניות מנוי ומסלולים' },
  products:       { num: 4, labelEn: 'Products',          labelHe: 'מוצרים',         descEn: 'product catalog with pricing',                        descHe: 'קטלוג מוצרים עם מחירים' },
  team:           { num: 5, labelEn: 'Meet the Team',     labelHe: 'הצוות שלנו',     descEn: 'staff profiles and bios',                             descHe: 'פרופילים וביוגרפיות' },
  testimonials:   { num: 6, labelEn: 'Testimonials',      labelHe: 'המלצות',         descEn: 'customer reviews and quotes',                         descHe: 'ביקורות ואמרות לקוחות' },
  gallery:        { num: 7, labelEn: 'Photo Gallery',     labelHe: 'גלריית תמונות',  descEn: 'showcase sections for images',                        descHe: 'קבצי תמונה ותצוגה' },
}

const ADDON_KEYS_ORDERED: AddonKey[] = ['bookingWidget', 'paymentOptions', 'memberships', 'products', 'team', 'testimonials', 'gallery']

function parseAddonSelection(text: string): AddonKey[] {
  const lower = text.toLowerCase()
  if (/^(skip|none|no|דלג|אין|לא)(?:\b|$)/i.test(text.trim())) return []

  const selected = new Set<AddonKey>()

  // Number matching (1-7)
  const nums = lower.match(/\b[1-7]\b/g)
  if (nums) {
    for (const n of nums) {
      const num = parseInt(n, 10)
      const key = ADDON_KEYS_ORDERED.find((k) => ADDON_INFO[k].num === num)
      if (key) selected.add(key)
    }
  }

  // Name matching (English)
  if (/booking|calendar|יומן/.test(lower))     selected.add('bookingWidget')
  if (/payment|תשלום/.test(lower))             selected.add('paymentOptions')
  if (/membership|מנוי|מנויים/.test(lower))    selected.add('memberships')
  if (/product|מוצר/.test(lower))              selected.add('products')
  if (/team|staff|צוות/.test(lower))           selected.add('team')
  if (/testimonial|review|המלצה|ביקורת/.test(lower)) selected.add('testimonials')
  if (/gallery|photo|גלריה|תמונה/.test(lower)) selected.add('gallery')

  // "all" → select everything
  if (/\ball\b|הכל|הכול/.test(lower)) return [...ADDON_KEYS_ORDERED]

  return ADDON_KEYS_ORDERED.filter((k) => selected.has(k))
}

function qAddonsMenu(ctx: SkillContext): string {
  const isHe = ctx.language === 'he'
  const lines = ADDON_KEYS_ORDERED.map((k) => {
    const info = ADDON_INFO[k]
    return isHe
      ? `${info.num}️⃣ *${info.labelHe}* — ${info.descHe}`
      : `${info.num}️⃣ *${info.labelEn}* — ${info.descEn}`
  }).join('\n')

  if (isHe) {
    return `✅ *האתר הבסיסי נשמר!*

האם תרצו להוסיף עמודים מיוחדים לאתר?

${lines}

ענו עם מספרים (לדוגמה "1, 3, 5"), שמות, *הכל*, או *דלג* להמשיך לפריסה.`
  }
  return `✅ *Base website saved!*

Would you like to add any special sections to your site?

${lines}

Reply with numbers (e.g. "1, 3, 5"), names, *all*, or *skip* to proceed to deployment.`
}

function qAddonQuestion(ctx: SkillContext, key: AddonKey, state: WbsState): string {
  const isHe = ctx.language === 'he'
  const info = ADDON_INFO[key]
  const currency = ctx.business.currency
  const serviceNames = ctx.businessKnowledge.services.map((s) => s.name).join(', ')

  const progressDone = (state.selectedAddons?.length ?? 1) - (state.pendingAddons?.length ?? 1)
  const progressTotal = state.selectedAddons?.length ?? 1
  const progressLine = progressTotal > 1
    ? (isHe ? `\n_(${progressDone + 1}/${progressTotal}: ${info.labelHe})_` : `\n_(${progressDone + 1}/${progressTotal}: ${info.labelEn})_`)
    : ''

  if (isHe) {
    const q: Record<AddonKey, string> = {
      bookingWidget:  `📅 *יומן הזמנות*${progressLine}\n\nאיזה שירותים להציג ביומן (או "הכל")?\nכמה ימים קדימה להציג?\nלהציג מחירים? (כן/לא)\n\nלדוגמה: "הכל, 14 ימים, כן"\nשירותים קיימים: ${serviceNames}`,
      paymentOptions: `💳 *אמצעי תשלום*${progressLine}\n\nאיזה אמצעי תשלום אתם מקבלים? (לדוגמה: מזומן, כרטיס אשראי, ביט, PayPal)\nיש לכם קישורי תשלום? צרפו אותם.\n\nלדוגמה: "מזומן, כרטיס, ביט — https://bit.ly/mybiz"`,
      memberships:    `👑 *מנויים*${progressLine}\n\nתארו את מסלולי המנוי שלכם. לכל מסלול:\nשם, מחיר (ב-${currency}), תקופה, ומה כלול.\n\nלדוגמה: "בסיסי — 200 ${currency}/חודש — 4 טיפולים, 10% הנחה"`,
      products:       `🛍 *מוצרים*${progressLine}\n\nפרטו את המוצרים שלכם. לכל מוצר:\nשם, תיאור קצר, ומחיר.\n\nלדוגמה: "ערכת שמן ארומתרפי — ערכה לשימוש ביתי — 180 ${currency}"`,
      team:           `👥 *הצוות שלנו*${progressLine}\n\nספרו על חברי הצוות. לכל חבר:\nשם, תפקיד, וביו קצר.\n\nלדוגמה: "שרה כהן — מטפלת ראשית — מומחית בעיסוי רקמות עמוקות עם 8 שנות ניסיון"`,
      testimonials:   `⭐ *המלצות*${progressLine}\n\nשתפו 3–5 המלצות לקוחות. לכל אחת:\nשם (או ראשי תיבות), ציטוט, ושירות שהתקבל.\n\nלדוגמה: "מ.כ. — 'העיסוי הכי טוב שקיבלתי!' — עיסוי שוודי"`,
      gallery:        `🖼 *גלריית תמונות*${progressLine}\n\nאיזה קבצי/קטגוריות תמונות תרצו?\n\nלדוגמה: "הסטודיו שלנו, לפני ואחרי, הצוות בעבודה"`,
    }
    return q[key]
  }
  const q: Record<AddonKey, string> = {
    bookingWidget:  `📅 *Booking Calendar*${progressLine}\n\nWhich services to show (or "all")?\nHow far ahead to display? (e.g. "2 weeks")\nShow prices? (yes/no)\n\nExample: "all, 2 weeks, yes"\nAvailable services: ${serviceNames}`,
    paymentOptions: `💳 *Payment Options*${progressLine}\n\nWhat payment methods do you accept? (e.g. Cash, Credit card, PayPal, Bit)\nAny payment links? Include them.\n\nExample: "Cash, credit card, Bit — https://bit.ly/mybiz"`,
    memberships:    `👑 *Memberships*${progressLine}\n\nDescribe your membership plans. For each:\nName, price (in ${currency}), period, and what's included.\n\nExample: "Basic — ${currency}200/month — 4 treatments, 10% discount"`,
    products:       `🛍 *Products*${progressLine}\n\nList your products. For each:\nName, short description, and price.\n\nExample: "Aromatherapy oil kit — home-use set — ${currency}180"`,
    team:           `👥 *Meet the Team*${progressLine}\n\nDescribe your team members. For each:\nName, role, and a short bio.\n\nExample: "Sarah Cohen — Head Therapist — Deep tissue specialist with 8 years of experience"`,
    testimonials:   `⭐ *Testimonials*${progressLine}\n\nShare 3–5 customer quotes. For each:\nName (or initials), their quote, and the service they received.\n\nExample: "M.K. — 'Best massage I've ever had!' — Swedish Massage"`,
    gallery:        `🖼 *Photo Gallery*${progressLine}\n\nWhat gallery sections would you like?\n\nExample: "Our Studio, Before & After, Team at Work"`,
  }
  return q[key]
}

function formatAddonLabels(keys: AddonKey[], isHe: boolean): string {
  return keys.map((k) => isHe ? ADDON_INFO[k].labelHe : ADDON_INFO[k].labelEn).join(', ')
}

// ── Question builders ─────────────────────────────────────────────────────────

function qRequirementsGather(ctx: SkillContext): string {
  const isHe = ctx.language === 'he'
  const existing = ctx.businessKnowledge.websitePreviewUrl
    ? (isHe ? `יש לכם כבר אתר. בכדי לבנות אתר חדש, בואנו נאסוף כמה פרטים.` : `You already have a site — let's gather details for a fresh build.`)
    : ''

  if (isHe) {
    return `${existing ? existing + '\n\n' : ''}בואנו נבנה את האתר שלכם! אני צריך כמה פרטים:

*1. סגנון העיצוב:*
• *minimal* — נקי, מרווח, מינימליסטי
• *bold* — נועז, ניגודיות חזקה, כותרות דומיננטיות
• *professional* — שמרני, אמין, מקצועי

*2. צבע מועדף* — תאר בחופשיות (לדוגמה: "ירוק וטבעי", "כחול כהה", "זהב ושחור")

*3. שם המטפל/ת (אם רלוונטי)* — לדף "אודות" ונוכחות מקצועית

*4. כתובת*, שנת הקמה, הסמכות מקצועיות (אם לא הוזנו בעבר)

*5. דומיין מועדף* — אם יש לכם שם דומיין בראש?

ענו בחופשיות — אסביר לכם מה יצא!`
  }
  return `${existing ? existing + '\n\n' : ''}Let's build your website! I need a few details:

*1. Design style:*
• *minimal* — clean, spacious, understated
• *bold* — strong contrast, dominant headlines, vivid color
• *professional* — conservative, trust-forward, serif typography

*2. Color preference* — describe freely (e.g. "forest green", "deep navy", "gold and black")

*3. Practitioner name (if applicable)* — for an About page and professional credibility

*4. Address*, founding year, professional credentials (if not already in the PA's knowledge)

*5. Domain preference* — do you have a domain name in mind?

Answer freely — I'll tell you what we'll build!`
}

function qStructureConfirm(ctx: SkillContext, state: WbsState): string {
  const isHe = ctx.language === 'he'
  const biz = ctx.business
  const hasAbout = !!(state.practitionerName)
  const paletteDisplay = state.palette ?? 'midnight-blue'
  const style = state.styleVariant ?? 'professional'

  const pages = [
    isHe ? '🏠 עמוד הבית' : '🏠 Homepage',
    isHe ? '🛎 שירותים' : '🛎 Services',
    isHe ? '❓ שאלות נפוצות' : '❓ FAQ',
    ...(hasAbout ? [isHe ? '👤 אודות' : '👤 About'] : []),
    isHe ? '📞 צור קשר' : '📞 Contact & Booking',
  ]

  const services = ctx.businessKnowledge.services.map((s) => `• ${s.name}`).join('\n')

  if (isHe) {
    return `מעולה! הנה מה שנבנה ל-*${biz.name}*:

*עמודים (${pages.length}):*
${pages.join('\n')}

*שירותים שיוצגו:*
${services || '• (מהמידע הקיים)'}

*עיצוב:* ${style} · פלטה: ${paletteDisplay}
${state.address ? '*כתובת:* ' + state.address : ''}
${state.practitionerName ? '*אודות:* ' + state.practitionerName + (state.practitionerTitle ? ' — ' + state.practitionerTitle : '') : ''}

*כלול בכל עמוד:* קישור WhatsApp, ידידותי לסוכני AI, בנוי לאינדוקס

ענו *אשר* להמשיך, או תארו מה לשנות.`
  }
  return `Great! Here's what we'll build for *${biz.name}*:

*Pages (${pages.length}):*
${pages.join('\n')}

*Services featured:*
${services || '• (from existing knowledge)'}

*Design:* ${style} · Palette: ${paletteDisplay}
${state.address ? '*Address:* ' + state.address : ''}
${state.practitionerName ? '*About:* ' + state.practitionerName + (state.practitionerTitle ? ' — ' + state.practitionerTitle : '') : ''}

*Included on every page:* WhatsApp link, AI-agent readable, built for indexing

Reply *APPROVE* to continue, or describe what to change.`
}

function qEditRequest(ctx: SkillContext): string {
  const isHe = ctx.language === 'he'
  const previewUrl = ctx.businessKnowledge.websitePreviewUrl ?? ctx.businessKnowledge.websiteUrl ?? ''

  if (isHe) {
    return `📝 האתר הנוכחי שלכם: ${previewUrl}

מה תרצו לשנות? תארו בחופשיות:
• "הוסיפו שירות: פנים, 60 דקות, ₪350"
• "שנו את הסלוגן ל-'...'"
• "עדכנו שעות פעילות — סגורים בשבת"
• "עברו לפלטה ocean-teal"
• או כל שינוי אחר

(ענו *ביטול* כדי להשאיר את האתר ללא שינוי)`
  }
  return `📝 Your current site: ${previewUrl}

What would you like to change? Describe freely:
• "Add a service: facial, 60 min, ₪350"
• "Change the tagline to '...'"
• "Update hours — closed Sundays"
• "Switch palette to ocean-teal"
• Or anything else

(Reply *cancel* to leave the site unchanged)`
}

// ── Requirements parsing ──────────────────────────────────────────────────────

function parseRequirements(text: string): Partial<WbsState> {
  const result: Partial<WbsState> = {}
  const lower = text.toLowerCase()

  // Style
  if (/\bminimal\b/.test(lower)) result.styleVariant = 'minimal'
  else if (/\bbold\b/.test(lower)) result.styleVariant = 'bold'
  else if (/\bprofessional\b/.test(lower)) result.styleVariant = 'professional'

  // Address — look for patterns with numbers + street names
  const addressMatch = text.match(/\b\d+\s+[^\n,]{3,30}(?:,\s*[^\n,]{2,20})?/)
  if (addressMatch) result.address = addressMatch[0].trim()

  // Founded year
  const yearMatch = text.match(/\b(19|20)\d{2}\b/)
  if (yearMatch) result.foundedYear = parseInt(yearMatch[0], 10)

  // Google Business Profile URL
  const gbpMatch = text.match(/https?:\/\/(?:maps\.google|g\.page|business\.google)\S+/)
  if (gbpMatch) result.googleBusinessProfileUrl = gbpMatch[0]

  // Domain preference
  const domainMatch = text.match(/\b[\w-]+\.(com|co\.il|io|app|site|net|org)\b/i)
  if (domainMatch) result.domainPreference = domainMatch[0]

  // Color hint — everything that isn't a keyword
  result.paletteHint = text

  return result
}

// ── Site builder call ─────────────────────────────────────────────────────────

async function callSiteBuilder(siteSchema: SiteSchema, workflowId: string): Promise<string | null> {
  const builderUrl = process.env['SITE_BUILDER_URL'] ?? 'http://localhost:3000'
  const secret = process.env['SITE_BUILDER_SECRET'] ?? ''

  try {
    const res = await fetch(`${builderUrl}/build-site`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ schema: siteSchema, workflowId }),
    })
    if (!res.ok) return null
    const data = await res.json() as { previewUrl?: string }
    return data.previewUrl ?? null
  } catch {
    return null
  }
}

// ── Main skill ────────────────────────────────────────────────────────────────

export const websiteBuilderSkill: Skill = {
  name: 'website-builder',

  canHandle(ctx: SkillContext): boolean {
    // Resume active workflow
    if (ctx.workflowState?.skillName === 'website-builder') return true
    // Manager-only for all new triggers
    if (ctx.caller.role !== 'manager') return false
    const t = ctx.message.text
    // Note: \b doesn't work with Hebrew (Hebrew chars are \W); we test for the
    // target phrases as substrings — the phrases are specific enough to be safe.
    // Build triggers — English (word-boundary safe) + Hebrew (substring)
    if (/\b(website|landing page)\b/i.test(t)) return true
    if (/\bbuild\b.*\bsite\b|\bcreate\b.*\bsite\b/i.test(t)) return true
    if (/אתר|דף נחיתה|בנה אתר|צור אתר/.test(t)) return true
    // Update triggers
    if (/\b(update|edit|change|modify)\b.*(website|site)\b/i.test(t)) return true
    if (/\b(website|site)\b.*(update|edit|change)\b/i.test(t)) return true
    if (/(עדכן|שנה|ערוך|תעדכן).*(אתר|דף)/.test(t)) return true
    if (/(אתר|דף).*(עדכן|שנה)/.test(t)) return true
    return false
  },

  async handle(ctx: SkillContext): Promise<SkillOutcome> {
    const lang = ctx.language
    const skillName = this.name

    try {
      // ── Start or resume ────────────────────────────────────────────────────
      if (!ctx.workflowState) {
        const hasExistingSite = !!(ctx.businessKnowledge.websitePreviewUrl ?? ctx.businessKnowledge.websiteUrl)
        if (hasExistingSite) {
          // Update flow
          const initialState: WbsState = {
            isUpdateFlow: true,
            ...(ctx.businessKnowledge.websiteJson ? { siteSchema: ctx.businessKnowledge.websiteJson } : {}),
          }
          await ctx.workflow.create(skillName, 'edit-request', initialState as unknown as Record<string, unknown>)
          return { handled: true, reply: qEditRequest(ctx), sessionComplete: false, skillName }
        } else {
          // Build flow
          await ctx.workflow.create(skillName, 'requirements-gather', {})
          return { handled: true, reply: qRequirementsGather(ctx), sessionComplete: false, skillName }
        }
      }

      const wf = ctx.workflowState
      const state = wf.state as unknown as WbsState
      const step = wf.step as Step

      // ── Universal cancel ───────────────────────────────────────────────────
      if (isCancelText(ctx.message.text) && step !== 'complete') {
        await ctx.workflow.complete()
        if (state.isUpdateFlow) {
          const url = ctx.businessKnowledge.websitePreviewUrl ?? ctx.businessKnowledge.websiteUrl ?? ''
          const reply = lang === 'he'
            ? `ביטול — האתר נשאר ללא שינוי.${url ? '\n🌐 ' + url : ''}`
            : `Cancelled — your site is unchanged.${url ? '\n🌐 ' + url : ''}`
          return { handled: true, reply, sessionComplete: true, skillName }
        }
        const reply = lang === 'he'
          ? '✅ שמרתי את ההתקדמות. אמרו "בנה אתר" כדי להמשיך.'
          : '✅ Saved your progress. Say "build my website" to continue.'
        return { handled: true, reply, sessionComplete: true, skillName }
      }

      // ── Step dispatch ──────────────────────────────────────────────────────
      return await dispatchStep(step, ctx, state, skillName)
    } catch {
      return {
        handled: true,
        reply: lang === 'he' ? 'אירעה שגיאה. נסו שוב.' : 'Something went wrong. Please try again.',
        sessionComplete: false,
        skillName,
      }
    }
  },
}

// ── Step dispatcher ───────────────────────────────────────────────────────────

async function dispatchStep(step: Step, ctx: SkillContext, state: WbsState, skillName: string): Promise<SkillOutcome> {
  const lang = ctx.language
  const isHe = lang === 'he'
  const text = ctx.message.text.trim()

  async function advance(nextStep: Step | 'done', newState: WbsState): Promise<void> {
    if (nextStep === 'done') {
      await ctx.workflow.complete()
    } else {
      await ctx.workflow.advance(nextStep, newState as unknown as Record<string, unknown>)
    }
  }

  switch (step) {

    // ── 1. requirements-gather ─────────────────────────────────────────────
    case 'requirements-gather': {
      const parsed = parseRequirements(text)

      // Suggest palette from description
      let palette = 'midnight-blue'
      if (parsed.paletteHint) {
        palette = await suggestPalette(parsed.paletteHint, ctx.businessKnowledge.brandVoice)
      }

      const ns: WbsState = {
        ...state,
        styleVariant: parsed.styleVariant ?? 'professional',
        palette,
        ...(parsed.paletteHint ? { paletteHint: parsed.paletteHint } : {}),
        ...(parsed.address !== undefined ? { address: parsed.address } : {}),
        ...(parsed.foundedYear !== undefined ? { foundedYear: parsed.foundedYear } : {}),
        ...(parsed.googleBusinessProfileUrl !== undefined ? { googleBusinessProfileUrl: parsed.googleBusinessProfileUrl } : {}),
        ...(parsed.domainPreference !== undefined ? { domainPreference: parsed.domainPreference } : {}),
      }

      // Extract practitioner details from free text
      const nameMatch = text.match(/(?:my name is|I'm|I am|practitioner[:\s]+)([A-Z][a-z]+ [A-Z][a-z]+)/i)
        ?? text.match(/(?:השם שלי|אני|המטפל[:\s]+)([א-ת]+\s[א-ת]+)/u)
      if (nameMatch) ns.practitionerName = nameMatch[1] ?? null

      await advance('structure-confirm', ns)
      return { handled: true, reply: qStructureConfirm(ctx, ns), sessionComplete: false, skillName }
    }

    // ── 2. structure-confirm ───────────────────────────────────────────────
    case 'structure-confirm': {
      if (isApproveText(text) || isSkipText(text)) {
        const ns: WbsState = { ...state, structureConfirmed: true }
        await advance('content-generate', ns)
        // Generate content inline — the manager gets the result in this same turn
        return await runContentGenerate(ctx, ns, skillName)
      }

      // Manager wants to change something — re-parse and re-show
      const updates = parseRequirements(text)
      const ns: WbsState = {
        ...state,
        ...(updates.styleVariant ? { styleVariant: updates.styleVariant } : {}),
        ...(updates.paletteHint ? { paletteHint: updates.paletteHint } : {}),
        ...(updates.address !== undefined ? { address: updates.address } : {}),
        ...(updates.foundedYear !== undefined ? { foundedYear: updates.foundedYear } : {}),
      }
      if (updates.paletteHint) {
        ns.palette = await suggestPalette(updates.paletteHint, ctx.businessKnowledge.brandVoice)
      }
      await ctx.workflow.advance('structure-confirm', ns as unknown as Record<string, unknown>)
      return { handled: true, reply: qStructureConfirm(ctx, ns), sessionComplete: false, skillName }
    }

    // ── 3. content-generate ────────────────────────────────────────────────
    case 'content-generate': {
      return await runContentGenerate(ctx, state, skillName)
    }

    // ── 4. aeo-pass ────────────────────────────────────────────────────────
    case 'aeo-pass': {
      const rawSchema = state.siteSchema
      if (!rawSchema) {
        await ctx.workflow.fail({ code: 'MISSING_SCHEMA', message: 'Site schema missing at aeo-pass', recoverable: false })
        return { handled: true, reply: isHe ? 'שגיאה פנימית — ליצור קשר עם התמיכה.' : 'Internal error — please contact support.', sessionComplete: true, skillName }
      }

      const parsed = SiteSchemaZod.safeParse(rawSchema)
      if (!parsed.success) {
        await ctx.workflow.fail({ code: 'SCHEMA_INVALID', message: 'Site schema failed validation at aeo-pass', recoverable: false })
        return { handled: true, reply: isHe ? 'שגיאה בנתונים — ליצור קשר עם התמיכה.' : 'Data error — please contact support.', sessionComplete: true, skillName }
      }

      const { schema: fixedSchema, report } = await runFullAeoPass(parsed.data)
      const ns: WbsState = { ...state, siteSchema: fixedSchema as unknown as Record<string, unknown>, aeoReport: report }
      await advance('preview-deploy', ns)
      return await runPreviewDeploy(ctx, ns, skillName)
    }

    // ── 5. preview-deploy ──────────────────────────────────────────────────
    case 'preview-deploy': {
      return await runPreviewDeploy(ctx, state, skillName)
    }

    // ── 6. manager-review ──────────────────────────────────────────────────
    case 'manager-review': {
      if (isApproveText(text) || isSkipText(text)) {
        // Update flow or already through add-ons menu: go straight to domain-setup
        if (state.isUpdateFlow || state.baseApproved) {
          const ns: WbsState = { ...state }
          await advance('domain-setup', ns)
          return await runDomainSetup(ctx, ns, skillName)
        }
        // Build flow, first approval: offer add-ons
        const ns: WbsState = { ...state, baseApproved: true }
        await ctx.workflow.advance('addons-menu', ns as unknown as Record<string, unknown>)
        return { handled: true, reply: qAddonsMenu(ctx), sessionComplete: false, skillName }
      }

      // Edit request — loop back
      const loopCount = (state.editLoopCount ?? 0) + 1
      if (loopCount > 5) {
        await ctx.workflow.complete()
        const url = state.previewUrl ?? ''
        const reply = isHe
          ? `✅ האתר נשמר עם המצב האחרון.\n🌐 ${url}\n\nלעדכונים נוספים — שלחו "עדכן אתר".`
          : `✅ Site saved at current state.\n🌐 ${url}\n\nFor further updates, say "update my website".`
        return { handled: true, reply, sessionComplete: true, skillName }
      }

      // Store feedback and loop back to generate or patch
      const ns: WbsState = { ...state, editLoopCount: loopCount, editRequest: text }
      const nextStep: Step = state.isUpdateFlow ? 'content-patch' : 'content-generate'
      await ctx.workflow.advance(nextStep, ns as unknown as Record<string, unknown>)
      return nextStep === 'content-patch'
        ? await runContentPatch(ctx, ns, skillName)
        : await runContentGenerate(ctx, ns, skillName)
    }

    // ── 7. addons-menu ────────────────────────────────────────────────────
    case 'addons-menu': {
      const selected = parseAddonSelection(text)
      if (selected.length === 0) {
        // No add-ons selected — go straight to deployment
        const ns: WbsState = { ...state }
        await advance('domain-setup', ns)
        return await runDomainSetup(ctx, ns, skillName)
      }
      const firstKey = selected[0] as AddonKey
      const ns: WbsState = {
        ...state,
        selectedAddons: selected,
        pendingAddons: [...selected],
        currentAddonKey: firstKey,
        addonGatherState: {},
      }
      await ctx.workflow.advance('addon-gather', ns as unknown as Record<string, unknown>)
      return { handled: true, reply: qAddonQuestion(ctx, firstKey, ns), sessionComplete: false, skillName }
    }

    // ── 8. addon-gather ───────────────────────────────────────────────────
    case 'addon-gather': {
      const currentKey = state.currentAddonKey
      if (!currentKey) {
        // Shouldn't happen — safety fallback
        const ns: WbsState = { ...state }
        await advance('domain-setup', ns)
        return await runDomainSetup(ctx, ns, skillName)
      }

      // Store the owner's answer for the current add-on
      const ns: WbsState = {
        ...state,
        addonGatherState: {
          ...state.addonGatherState,
          [currentKey]: { rawText: text },
        },
      }

      const remaining = (state.pendingAddons ?? []).slice(1)

      if (remaining.length > 0) {
        // More add-ons to gather
        const nextKey = remaining[0]!
        const ns2: WbsState = { ...ns, pendingAddons: remaining, currentAddonKey: nextKey }
        await ctx.workflow.advance('addon-gather', ns2 as unknown as Record<string, unknown>)
        return { handled: true, reply: qAddonQuestion(ctx, nextKey, ns2), sessionComplete: false, skillName }
      }

      // All add-ons gathered — generate enhanced site
      const ns2: WbsState = { ...ns, pendingAddons: [] }
      return await runAddonGenerate(ctx, ns2, skillName)
    }

    // ── 10. domain-setup (GATE-1) ──────────────────────────────────────────
    case 'domain-setup': {
      return await runDomainSetup(ctx, state, skillName)
    }

    // ── 11. deploy (GATE-1) ────────────────────────────────────────────────
    case 'deploy': {
      // GATE-1 not resolved — stay paused
      const reply = isHe
        ? `⏳ הגדרת הדומיין בהכנה. נעדכן אתכם כשהשלב הזה יהיה מוכן.`
        : `⏳ Domain deployment is being set up. We'll notify you when this step is ready.`
      return { handled: true, reply, sessionComplete: false, skillName }
    }

    // ── 12. complete ───────────────────────────────────────────────────────
    case 'complete': {
      await ctx.workflow.complete()
      const url = state.previewUrl ?? ''
      const aeoLine = state.aeoReport
        ? `AEO: ${state.aeoReport.passedCount}/${state.aeoReport.totalCount}${state.aeoReport.advisoryScore ? ' · Score: ' + state.aeoReport.advisoryScore + '/5' : ''}`
        : ''
      const reply = isHe
        ? `✅ *האתר שלכם מוכן!*\n\n🌐 ${url}\n\n${aeoLine}\n\n*מה הלאה:*\n• שתפו את הקישור עם לקוחות\n• הוסיפו לפרופיל Google Business שלכם\n\nלעדכונים — אמרו "עדכן אתר".`
        : `✅ *Your website is ready!*\n\n🌐 ${url}\n\n${aeoLine}\n\n*What's next:*\n• Share the link with customers\n• Add it to your Google Business Profile\n\nTo update — say "update my website".`
      return { handled: true, reply, sessionComplete: true, skillName }
    }

    // ── U1. edit-request ───────────────────────────────────────────────────
    case 'edit-request': {
      const ns: WbsState = { ...state, editRequest: text }

      // Safety net: if websiteJson is null, fall back to content-generate
      if (!ns.siteSchema) {
        await ctx.workflow.advance('content-generate', ns as unknown as Record<string, unknown>)
        const fallback = isHe
          ? 'לא מצאתי את נתוני האתר השמורים — מייצר מחדש מהמידע הקיים...'
          : "Couldn't find your saved site data — regenerating from business knowledge..."
        const result = await runContentGenerate(ctx, ns, skillName)
        if (result.handled) {
          return { ...result, reply: fallback + '\n\n' + result.reply }
        }
        return result
      }

      await ctx.workflow.advance('content-patch', ns as unknown as Record<string, unknown>)
      return await runContentPatch(ctx, ns, skillName)
    }

    // ── U2. content-patch ──────────────────────────────────────────────────
    case 'content-patch': {
      return await runContentPatch(ctx, state, skillName)
    }
  }
}

// ── Shared step runners ───────────────────────────────────────────────────────

async function runContentGenerate(ctx: SkillContext, state: WbsState, skillName: string): Promise<SkillOutcome> {
  const lang = ctx.language
  const isHe = lang === 'he'
  const wf = ctx.workflowState!

  // If there's a pending editRequest, use it as feedback context in the prompt
  // (handled by generateSiteContent using businessKnowledge — manager feedback is advisory only)
  const generated = await generateSiteContent(
    ctx,
    wf.id,
    state.styleVariant ?? 'professional',
    state.paletteHint ?? state.palette ?? 'professional deep blue',
    {
      practitionerName: state.practitionerName ?? null,
      practitionerTitle: state.practitionerTitle ?? null,
      practitionerBio: state.practitionerBio ?? null,
      address: state.address ?? null,
      credentials: state.credentials ?? [],
      foundedYear: state.foundedYear ?? null,
      googleBusinessProfileUrl: state.googleBusinessProfileUrl ?? null,
      domainPreference: state.domainPreference ?? null,
    },
  )

  if (!generated) {
    const ns: WbsState = { ...state }
    await ctx.workflow.advance('content-generate', ns as unknown as Record<string, unknown>)
    return {
      handled: true,
      reply: isHe ? '⚠️ לא הצלחתי לייצר תוכן. נסו שוב.' : '⚠️ Content generation failed. Please try again.',
      sessionComplete: false,
      skillName,
    }
  }

  const ns: WbsState = { ...state, siteSchema: generated as unknown as Record<string, unknown> }
  await ctx.workflow.advance('aeo-pass', ns as unknown as Record<string, unknown>)

  // Run AEO pass immediately
  const { schema: fixedSchema, report } = await runFullAeoPass(generated)
  const ns2: WbsState = { ...ns, siteSchema: fixedSchema as unknown as Record<string, unknown>, aeoReport: report }
  await ctx.workflow.advance('preview-deploy', ns2 as unknown as Record<string, unknown>)

  return await runPreviewDeploy(ctx, ns2, skillName)
}

async function runContentPatch(ctx: SkillContext, state: WbsState, skillName: string): Promise<SkillOutcome> {
  const lang = ctx.language
  const isHe = lang === 'he'

  const existingSchemaRaw = state.siteSchema
  if (!existingSchemaRaw) {
    return {
      handled: true,
      reply: isHe ? '⚠️ לא נמצאו נתוני אתר קיימים.' : '⚠️ No existing site data found.',
      sessionComplete: false,
      skillName,
    }
  }

  const parsedExisting = SiteSchemaZod.safeParse(existingSchemaRaw)
  if (!parsedExisting.success) {
    return {
      handled: true,
      reply: isHe ? '⚠️ שגיאה בנתוני האתר. נסו "בנה אתר" מחדש.' : '⚠️ Site data error. Try "build my website" to start fresh.',
      sessionComplete: false,
      skillName,
    }
  }

  const patched = await patchSiteContent(parsedExisting.data, state.editRequest ?? '', ctx)

  if (!patched) {
    await ctx.workflow.advance('content-patch', state as unknown as Record<string, unknown>)
    return {
      handled: true,
      reply: isHe ? '⚠️ לא הצלחתי לעדכן. נסו שוב.' : '⚠️ Update failed. Please try again.',
      sessionComplete: false,
      skillName,
    }
  }

  const { schema: fixedSchema, report } = await runFullAeoPass(patched)
  const ns: WbsState = { ...state, siteSchema: fixedSchema as unknown as Record<string, unknown>, aeoReport: report }
  await ctx.workflow.advance('preview-deploy', ns as unknown as Record<string, unknown>)

  return await runPreviewDeploy(ctx, ns, skillName)
}

async function runPreviewDeploy(ctx: SkillContext, state: WbsState, skillName: string): Promise<SkillOutcome> {
  const lang = ctx.language
  const isHe = lang === 'he'
  const wf = ctx.workflowState!

  const rawSchema = state.siteSchema
  if (!rawSchema) {
    return { handled: true, reply: isHe ? 'שגיאה: חסר תוכן אתר.' : 'Error: missing site content.', sessionComplete: false, skillName }
  }

  const parsed = SiteSchemaZod.safeParse(rawSchema)
  if (!parsed.success) {
    return { handled: true, reply: isHe ? 'שגיאה בתוכן האתר.' : 'Site content error.', sessionComplete: false, skillName }
  }

  let previewUrl: string | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    previewUrl = await callSiteBuilder(parsed.data, wf.id)
    if (previewUrl) break
  }

  if (!previewUrl) {
    await ctx.workflow.fail({
      code: 'PREVIEW_DEPLOY_FAILED',
      message: 'Site builder returned no preview URL after 3 attempts',
      recoverable: true,
    })
    return {
      handled: true,
      reply: isHe ? '⚠️ לא הצלחנו לייצר תצוגה מקדימה. הצוות שלנו יטפל בכך.' : '⚠️ Preview generation failed. Our team has been notified.',
      sessionComplete: true,
      skillName,
    }
  }

  // Save site config
  await ctx.saveWebsiteConfig(rawSchema, previewUrl)

  const ns: WbsState = { ...state, previewUrl }
  await ctx.workflow.advance('manager-review', ns as unknown as Record<string, unknown>)

  // Build manager-review message
  const aeoSummary = state.aeoReport ? formatAeoSummary(state.aeoReport, lang) : ''
  const changesSummary = state.isUpdateFlow && state.editRequest
    ? (isHe ? `\n\n*שינויים שהוחלו:* בהתאם לבקשתך — "${state.editRequest.slice(0, 80)}"` : `\n\n*Changes applied* based on: "${state.editRequest.slice(0, 80)}"`)
    : ''
  const addonsIncluded = state.selectedAddons?.length
    ? (isHe
        ? `\n\n*תוספות שנוספו:* ${formatAddonLabels(state.selectedAddons, true)}`
        : `\n\n*Add-ons included:* ${formatAddonLabels(state.selectedAddons, false)}`)
    : ''

  const reply = isHe
    ? `🌐 *תצוגה מקדימה של האתר מוכנה:*\n${previewUrl}${changesSummary}${addonsIncluded}\n\n${aeoSummary}\n\nפתחו את הקישור, עיינו, וענו:\n✅ *אשר* — להמשיך\n✏️ או תארו מה לשנות`
    : `🌐 *Your website preview is ready:*\n${previewUrl}${changesSummary}${addonsIncluded}\n\n${aeoSummary}\n\nOpen the link, take a look, and reply:\n✅ *APPROVE* — to proceed\n✏️ or describe what to change`

  return { handled: true, reply, sessionComplete: false, skillName }
}

async function runAddonGenerate(ctx: SkillContext, state: WbsState, skillName: string): Promise<SkillOutcome> {
  const lang = ctx.language
  const isHe = lang === 'he'

  const rawSchema = state.siteSchema
  if (!rawSchema) {
    return { handled: true, reply: isHe ? '⚠️ לא נמצאו נתוני אתר.' : '⚠️ No site data found.', sessionComplete: false, skillName }
  }

  const parsed = SiteSchemaZod.safeParse(rawSchema)
  if (!parsed.success) {
    return { handled: true, reply: isHe ? '⚠️ שגיאה בנתוני האתר.' : '⚠️ Site data error.', sessionComplete: false, skillName }
  }

  const addonInput = (state.addonGatherState ?? {}) as AddonGatherInput
  const withAddons = await generateAddonContent(parsed.data, addonInput, ctx)
  const schemaToUse = withAddons ?? parsed.data

  if (!withAddons) {
    // Addon generation failed — proceed with base site and inform the owner
    const warnLine = isHe
      ? '\n\n⚠️ חלק מהתוספות לא נוצרו — ניתן לנסות שוב מאוחר יותר.'
      : '\n\n⚠️ Some add-ons could not be generated — you can retry later.'
    const { schema: fixedSchema, report } = await runFullAeoPass(schemaToUse)
    const ns: WbsState = { ...state, siteSchema: fixedSchema as unknown as Record<string, unknown>, aeoReport: report }
    await ctx.workflow.advance('preview-deploy', ns as unknown as Record<string, unknown>)
    const result = await runPreviewDeploy(ctx, ns, skillName)
    if (result.handled) return { ...result, reply: result.reply + warnLine }
    return result
  }

  const { schema: fixedSchema, report } = await runFullAeoPass(withAddons)
  const ns: WbsState = { ...state, siteSchema: fixedSchema as unknown as Record<string, unknown>, aeoReport: report }
  await ctx.workflow.advance('preview-deploy', ns as unknown as Record<string, unknown>)
  return await runPreviewDeploy(ctx, ns, skillName)
}

async function runDomainSetup(ctx: SkillContext, state: WbsState, skillName: string): Promise<SkillOutcome> {
  const lang = ctx.language
  const isHe = lang === 'he'
  const url = state.previewUrl ?? ''

  // GATE-1 not resolved — stay at domain-setup as PAUSED
  if (process.env['GATE_1_RESOLVED'] !== 'true') {
    await ctx.workflow.advance('domain-setup', state as unknown as Record<string, unknown>)
    const reply = isHe
      ? `✅ *האתר מוכן ומאוחסן בתצוגה מקדימה!*\n\n🌐 ${url}\n\nאת הגדרת הדומיין וההפעלה הסופית נשלים כשהתשתית תהיה מוכנה. נעדכן אתכם.\n\nלעדכון תוכן — אמרו "עדכן אתר".`
      : `✅ *Website ready and saved as preview!*\n\n🌐 ${url}\n\nDomain setup and live deployment will be completed once the infrastructure is ready. We'll notify you.\n\nTo update content — say "update my website".`
    return { handled: true, reply, sessionComplete: false, skillName }
  }

  // GATE-1 resolved — future implementation
  const reply = isHe ? '🔜 הגדרת דומיין — בקרוב.' : '🔜 Domain setup — coming soon.'
  return { handled: true, reply, sessionComplete: false, skillName }
}
