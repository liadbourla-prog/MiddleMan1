import { z } from 'zod'
import { GoogleGenAI } from '@google/genai'
import type {
  Skill,
  SkillContext,
  SkillOutcome,
  CommunicationStyle,
  NotificationPreferences,
  HandoffBehavior,
  AutomatedMessagesConfig,
  BookingEdgeCases,
} from '../../shared/skill-types.js'
import { turnIntentSchema, buildTurnIntentPrompt, resolveInterjection, isBareControl } from '../../shared/turn-intent.js'

// ── LLM ──────────────────────────────────────────────────────────────────────

const ai = new GoogleGenAI({ apiKey: process.env['LLM_API_KEY'] ?? '', apiVersion: 'v1beta' })
const MODEL = 'gemini-2.5-flash'

async function callJson<T>(systemPrompt: string, userMessage: string, schema: z.ZodType<T>): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model: MODEL,
        contents: userMessage,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 2048,
          temperature: 0,
          responseMimeType: 'application/json',
        },
      })
      const text = result.text
      if (!text) continue
      let raw: unknown
      try { raw = JSON.parse(text) } catch { continue }
      const parsed = schema.safeParse(raw)
      if (parsed.success) return parsed.data
    } catch { /* retry */ }
  }
  return null
}

// ── State ─────────────────────────────────────────────────────────────────────

interface BksState {
  brandVoice?: string
  communicationStyle?: CommunicationStyle
  notificationPrefs?: NotificationPreferences
  handoffBehavior?: HandoffBehavior
  cancellationFeeAmount?: number | null
  cancellationFeeCurrency?: string
  serviceProgress?: string[]      // IDs already processed
  bookingEdgeCases?: BookingEdgeCases
  rawFaqInput?: string
  automatedMessages?: AutomatedMessagesConfig
  messageReviewGroup?: number     // 0-based, which group we're reviewing
  messageReviewFeedback?: string  // last manager feedback for regeneration
  messageReviewRegenCount?: number // regen attempts for current group (capped at 2)
  generatedFaqs?: Array<{ question: string; answer: string }>
  openQuestionCount?: number
  skippedSteps?: string[]
  websiteAlreadyExists?: boolean
  gmbAlreadyExists?: boolean
}

// ── Steps ─────────────────────────────────────────────────────────────────────

type Step =
  | 'brand-voice'
  | 'communication-style'
  | 'notification-prefs'
  | 'handoff-rules'
  | 'cancellation-payment-confirm'
  | 'service-narratives'
  | 'booking-edge-cases'
  | 'off-limits'
  | 'faq-collect'
  | 'message-review'
  | 'faq-review'
  | 'open-question'
  | 'website-offer'
  | 'gmb-offer'

// ── Intent detection ──────────────────────────────────────────────────────────

// Hebrew-safe trailing boundary. A bare `\b` does NOT match after a Hebrew letter
// at end-of-input (Hebrew is non-word in JS regex without /u), so `^(...|כן)\b`
// silently fails for ALL Hebrew keywords. This lookahead accepts a word boundary,
// end-of-string, whitespace, or punctuation — working for both scripts.
const KW_END = "(?=\\b|$|\\s|[.,!?'\"\\-])"

function isCancelText(text: string): boolean {
  return new RegExp("^(stop|cancel|never mind|quit|done|finished|סיים|עצור|בטל|די|הפסק|no thanks|that'?s (all|enough|ok))" + KW_END, 'i').test(text.trim())
}

function isSkipText(text: string): boolean {
  return new RegExp("^(skip|next|later|דלג|הבא|אחר כך|pass)" + KW_END, 'i').test(text.trim())
}

function isApproveText(text: string): boolean {
  return new RegExp("^(approve[d]?|confirm(?:ed)?|yes|sure|ok(?:ay)?|good|great|looks? good|perfect|אשר|מאשר(?:ת|ים)?|אישור|אישרתי|מאושר(?:ת)?|טוב|מעולה|כן|אוקיי|בטח|בסדר|יאלה|קדימה|סבבה|נראה טוב)" + KW_END, 'i').test(text.trim())
}

// ── Section re-run detection ──────────────────────────────────────────────────

function detectStartStep(text: string): Step {
  const lower = text.toLowerCase()
  if (/brand|voice|describe|business info|עדכן עסק|קול מותג/.test(lower)) return 'brand-voice'
  if (/communicat|style|tone|emoji|formal|casual|סגנון|תקשורת/.test(lower)) return 'communication-style'
  if (/notif|alert|ping|when.*happen|התראות|הודעות/.test(lower)) return 'notification-prefs'
  if (/handoff|takeover|escalat|העברה|מסירה/.test(lower)) return 'handoff-rules'
  if (/cancell.*fee|fee|cancell.*polic|ביטול|עמלה/.test(lower)) return 'cancellation-payment-confirm'
  if (/service|narrative|intake|שירות|פרטי שירות/.test(lower)) return 'service-narratives'
  if (/same.?day|walk.?in|pricing|deposit|הזמנה|עמלת/.test(lower)) return 'booking-edge-cases'
  if (/off.?limit|never|restrict|אסור|מגבלות/.test(lower)) return 'off-limits'
  if (/faq|question|customers? ask|שאלות/.test(lower)) return 'faq-collect'
  if (/message|reminder|template|הודעות|תבניות/.test(lower)) return 'message-review'
  return 'brand-voice'
}

// ── Questions ─────────────────────────────────────────────────────────────────

const Q: Record<Step, (ctx: SkillContext, state: BksState) => string> = {
  'brand-voice': (ctx) => ctx.language === 'he'
    ? `לפני שהלקוחות מגיעים, בואנו נלמד על *${ctx.business.name}* כדי שאוכל לייצג אתכם הכי טוב.

איך היית מתאר את *${ctx.business.name}*? מה הרגש שאתה רוצה שלקוחות יקבלו אחרי כל ביקור? מה מייחד אתכם?

(ככל שתשתף יותר, כך אדבר טוב יותר בשמך)`
    : `Before customers arrive, let me get to know *${ctx.business.name}* so I can represent you well.

How would you describe *${ctx.business.name}*? What feeling do you want customers to walk away with? What makes you stand out?

(The more detail you share, the better I'll speak in your voice)`,

  'communication-style': (ctx) => ctx.language === 'he'
    ? `מעולה! עכשיו בואנו נגדיר איך אני מתקשר עם לקוחות:

• פורמלי ("אתה") או קז'ואל ("אתם", שפה חופשית)?
• אימוג'ים: אף פעם / לפעמים / לעתים קרובות?
• להשתמש בשם הפרטי של הלקוח?
• הומור: כן / לא?
• ביטויים שמבייש אותך לראות מהנציג?
• ביטויים שאתה אוהב שמשתמשים בהם?
• אם לקוח גס — להיות נחרץ, רך, או להעביר אליך מיד?

ענה בכל צורה שנוחה לך — תיאור, רשימה, או פשוט "כמו שאני מדבר"`
    : `Great! Now let me understand how you like to communicate with customers:

• Formal ("Sir/Ma'am") or casual (first names, relaxed tone)?
• Emoji use: never / sometimes / often?
• Use the customer's first name in messages?
• Humor: yes or no?
• Any phrases you'd be embarrassed to see me write?
• Any phrases or expressions you love?
• If a customer is rude — be firm, stay soft and patient, or hand straight to you?

Answer however feels natural — a list, a description, or just say "talk like I do"`,

  'notification-prefs': (ctx) => ctx.language === 'he'
    ? `מתי אתה רוצה שאשלח לך התראה אישית?\n\n• תור חדש אושר\n• לקוח ראשון מזמין (כדי שתהיה מוכן)\n• ביטול התור\n• שינוי מועד\n• לא-הגיע (לקוח לא הופיע)\n• לקוח משתמש בשפה רגשית / כועסת\n\nאמור "הכל", "כלום", או מה שחשוב לך`
    : `When do you want me to send you a personal notification?\n\n• New booking confirmed\n• First-time customer books (so you can prepare)\n• A cancellation comes in\n• A customer reschedules\n• A no-show (customer never arrived)\n• A customer uses upset or emotional language\n\nSay "all of them", "none", or list the ones you care about`,

  'handoff-rules': (ctx) => ctx.language === 'he'
    ? `האם יש מצבים שבהם אתה רוצה לקחת שיחה בעצמך ולא להשאיר אותה לי?\n\nלמשל: לקוח ארגוני, תלונה, בקשה להנחה, ביקור יקר ערך.\n\nכשאני מעביר לך — מה לומר ללקוח? לדוגמה: "אעביר אתך ל[שמך]" או "הצוות יחזור אליך".\n\nויש מספר/דרך יצירת קשר אחרת שצריך להפנות אליה לסיטואציות מסוימות?`
    : `Are there situations where you want to take over personally and not leave them to me?\n\nFor example: corporate clients, complaints, discount requests, high-value bookings.\n\nWhen I hand off — what should I tell the customer? E.g. "I'll pass you to [your name]" or "The team will follow up".\n\nAnd is there a different number or contact to direct certain customers to?`,

  'cancellation-payment-confirm': (ctx) => {
    const lang = ctx.language
    const cutoffH = Math.round(ctx.businessKnowledge.policies.cancellationCutoffMinutes / 60)
    const feeAmt = ctx.businessKnowledge.cancellationFeeAmount
    const feeCur = ctx.businessKnowledge.cancellationFeeCurrency ?? ctx.business.currency
    const payMethod = ctx.businessKnowledge.paymentMethod
    const isPostPayment = ctx.businessKnowledge.confirmationGate === 'post_payment'

    if (lang === 'he') {
      const cancPolicy = cutoffH === 0 ? 'ללא הגבלה (לקוחות יכולים לבטל בכל עת)' : `${cutoffH} שעות לפני התור`
      const feeStr = feeAmt ? `עמלת ביטול: ${feeAmt} ${feeCur}` : 'אין עמלת ביטול'
      const payStr = isPostPayment ? `תשלום מראש דרך: ${payMethod ?? 'לא הוגדר'}` : 'ללא תשלום מראש'
      return `בואנו נאשר את הגדרות הביטול והתשלום שלך:\n\n*מדיניות ביטול:* ${cancPolicy}\n*${feeStr}*\n*תשלום:* ${payStr}\n\nהאם לשנות משהו? (למשל: "חלון ביטול 48 שעות", "עמלת ביטול 50 ש"ח", "שיטת תשלום ביט")\nאם הכל בסדר — ענה *אשר*`
    } else {
      const cancPolicy = cutoffH === 0 ? 'No restriction (customers can cancel any time)' : `${cutoffH}h before appointment`
      const feeStr = feeAmt ? `Cancellation fee: ${feeAmt} ${feeCur}` : 'No cancellation fee'
      const payStr = isPostPayment ? `Upfront payment via: ${payMethod ?? 'not set'}` : 'No upfront payment required'
      return `Let's confirm your cancellation and payment settings:\n\n*Cancellation policy:* ${cancPolicy}\n*${feeStr}*\n*Payment:* ${payStr}\n\nAnything to change? (e.g. "48h cancellation window", "₪50 late cancellation fee", "payment via Bit")\nIf everything's correct — reply *APPROVE*`
    }
  },

  'service-narratives': (ctx, state) => {
    const lang = ctx.language
    const done = state.serviceProgress ?? []
    const next = ctx.businessKnowledge.services.find((s) => !done.includes(s.id))
    if (!next) {
      return lang === 'he'
        ? 'עברנו על כל השירותים. ממשיכים הלאה...'
        : 'Covered all services. Moving on...'
    }
    const priceStr = next.price ? ` · ${next.price} ${next.currency}` : ''
    return lang === 'he'
      ? `בואנו נדבר על *${next.name}* (${next.durationMinutes} דקות${priceStr}):\n\n• מה הלקוח צריך לדעת לפני שמזמין?\n• מה להביא, להכין, או להימנע ממנו?\n• יש התוויות נגד או הגבלות?\n\n(ענה *דלג* אם לא רוצה להוסיף פרטים)`
      : `Let me learn about *${next.name}* (${next.durationMinutes} min${priceStr}):\n\n• What should a customer know before booking?\n• Anything to bring, prepare, or avoid beforehand?\n• Any contraindications or restrictions?\n\n(Reply *skip* if you'd rather not add details)`
  },

  'booking-edge-cases': (ctx) => ctx.language === 'he'
    ? `כמה שאלות קצרות על כללי ההזמנה שלך:\n\n• הזמנה באותו יום: מקבל? יש שעת סגירה (למשל "לא אחרי 14:00")?\n• walk-ins: מקבל אותם? אם כן — האם לציין זאת ללקוחות?\n• הזמנות בו-זמניות מאותו לקוח ביום אחד: מותר?\n• תמחור: האם לציין מחיר מראש, להגיד "צרו קשר למחיר", או לפי בקשה?\n• מקדמה: אתה גובה מקדמה? אם כן — מה לומר ללקוחות לגבי התשלום?`
    : `A few quick questions about your booking rules:\n\n• Same-day bookings: accepted? Any cut-off time (e.g. "not after 2pm")?\n• Walk-ins: do you take them? If yes — should I mention this to customers?\n• Back-to-back bookings from the same customer in one day: allowed?\n• Pricing: state the price upfront, say "contact us for pricing", or share on request?\n• Deposits: do you take them? If so, what should I tell customers about paying?`,

  'off-limits': (ctx) => ctx.language === 'he'
    ? `האם יש נושאים שאסור לי לטפל בהם — דברים שצריך להפנות ישירות אליך?\n\nלמשל: מיקוח על מחיר, הזמנות קבוצתיות גדולות, שאלות רפואיות ספציפיות, השוואות למתחרים.\n\nואיזה משפט לומר ללקוח כשאני לא יכול לעזור? לדוגמה: "פנה ישירות ל[שמך] בנייד" או "זה משהו שנצטרך לדבר עליו ישירות"`
    : `Are there topics you never want me to handle — things I should redirect straight to you?\n\nFor example: price negotiations, large group bookings, specific medical questions, competitor mentions.\n\nAnd what should I say to the customer when I can't help? For example: "Please reach out to [your name] directly" or "This is something we'll need to discuss in person"`,

  'faq-collect': (ctx) => ctx.language === 'he'
    ? `מה הלקוחות שואלים אותך הכי הרבה? אל תחשוב יותר מדי — רשום כל מה שעולה לך לראש. שאלות שחוזרות על עצמן, דברים שאתה מסביר שוב ושוב, מה חשוב לדעת לפני הביקור.\n\nככל שיותר — יותר טוב.`
    : `What do customers ask you most often? Don't overthink it — just list anything that comes to mind. Recurring questions, things you explain repeatedly, must-know info before arriving.\n\nThe more the better.`,

  'message-review': (ctx, state) => buildMessageReviewPrompt(ctx, state),

  'faq-review': (ctx, state) => buildFaqReviewPrompt(ctx, state),

  'open-question': (ctx) => ctx.language === 'he'
    ? `מצוין! כיסינו הרבה. יש משהו נוסף שרצית שאדע או שרצית לקבוע — משהו על העסק, על הלקוחות, על כל דבר שלא שאלתי?\n\n(ענה *סיים* אם הכל נאמר)`
    : `Great! We've covered a lot. Is there anything else you'd like me to know or set up — something about the business, customers, or anything I didn't ask?\n\n(Reply *done* if that's everything)`,

  'website-offer': (ctx) => ctx.language === 'he'
    ? 'רוצה שאבנה לך אתר עכשיו? זה לוקח רק כמה דקות.'
    : 'Want me to build you a website now? It only takes a few minutes.',

  'gmb-offer': (ctx) => ctx.language === 'he'
    ? 'רוצה גם להגדיר פרופיל Google Business? כך לקוחות ימצאו אותך בגוגל.'
    : 'Want to set up your Google Business profile too? That puts you on Google Maps.',
}

// ── Message review helpers ─────────────────────────────────────────────────────

const MESSAGE_GROUPS: Array<Array<keyof AutomatedMessagesConfig>> = [
  ['booking_confirmation', 'reminder_24h', 'reminder_1h', 'rescheduled_confirmation', 'post_appointment', 'review_request'],
  ['no_show', 'first_booking_welcome', 'cancellation_ack', 'waitlist_offer', 'payment_request'],
]

const MSG_LABELS: Record<keyof AutomatedMessagesConfig, { he: string; en: string }> = {
  booking_confirmation:    { he: 'אישור הזמנה',          en: 'Booking confirmation' },
  reminder_24h:            { he: 'תזכורת 24 שעות לפני', en: '24h reminder' },
  reminder_1h:             { he: 'תזכורת שעה לפני',      en: '1h reminder' },
  rescheduled_confirmation:{ he: 'אישור שינוי מועד',      en: 'Rescheduling confirmed' },
  post_appointment:        { he: 'מעקב לאחר הביקור',     en: 'Post-appointment follow-up' },
  review_request:          { he: 'בקשת ביקורת גוגל',     en: 'Google review request' },
  no_show:                 { he: 'לא הגיע',             en: 'No-show follow-up' },
  first_booking_welcome:   { he: 'ברוך הבא / לקוח חדש',  en: 'New customer welcome' },
  cancellation_ack:        { he: 'אישור ביטול',           en: 'Cancellation acknowledgment' },
  waitlist_offer:          { he: 'הצעת רשימת המתנה',      en: 'Waitlist slot offer' },
  payment_request:         { he: 'בקשת תשלום',            en: 'Payment request' },
}

function buildMessageReviewPrompt(ctx: SkillContext, state: BksState): string {
  const lang = ctx.language
  const msgs = state.automatedMessages
  if (!msgs) return lang === 'he' ? 'אנחנו מכינים את ההודעות...' : 'Preparing your messages...'

  const group = state.messageReviewGroup ?? 0
  const keys = MESSAGE_GROUPS[group]
  if (!keys) return lang === 'he' ? 'סיימנו את ההודעות.' : 'Messages done.'

  const isPostPayment = ctx.businessKnowledge.confirmationGate === 'post_payment'
  if (group === 3 && !isPostPayment) return lang === 'he' ? 'סיימנו את ההודעות.' : 'Messages done.'

  const lines: string[] = []
  const header = lang === 'he'
    ? `📝 *קבוצה ${group + 1} מתוך ${isPostPayment ? 4 : 3} — בדוק את ההודעות:*`
    : `📝 *Group ${group + 1} of ${isPostPayment ? 4 : 3} — review these messages:*`
  lines.push(header, '')

  for (const key of keys) {
    const tpl = msgs[key]
    const label = MSG_LABELS[key][lang]
    const status = tpl.enabled ? (lang === 'he' ? '✅ פעיל' : '✅ enabled') : (lang === 'he' ? '⬜ כבוי' : '⬜ off')
    lines.push(`*${label}* (${status})`)
    if (tpl.enabled) lines.push(`"${tpl.body}"`)
    lines.push('')
  }

  lines.push(lang === 'he'
    ? 'ענה *אשר* לאישור, או תאר מה לשנות.'
    : 'Reply *APPROVE* to confirm, or describe what to change.')

  return lines.join('\n')
}

function buildFaqReviewPrompt(ctx: SkillContext, state: BksState): string {
  const lang = ctx.language
  const faqs = state.generatedFaqs
  if (!faqs || faqs.length === 0) {
    return lang === 'he' ? 'לא הצלחתי לייצר שאלות ותשובות. ממשיכים הלאה.' : 'Could not generate FAQs. Moving on.'
  }

  const header = lang === 'he' ? `📋 *שאלות ותשובות שהכנתי לך:*\n` : `📋 *FAQs I've prepared for you:*\n`
  const body = faqs.map((f, i) => `*${i + 1}. ${f.question}*\n${f.answer}`).join('\n\n')
  const footer = lang === 'he'
    ? '\n\nענה *אשר* לשמירה, או תאר מה לשנות.'
    : '\n\nReply *APPROVE* to save, or describe what to change.'

  return header + body + footer
}

// ── LLM extraction schemas ─────────────────────────────────────────────────────

const commStyleSchema = z.object({
  formality: z.enum(['formal', 'casual']).catch('casual'),
  emojiUse: z.enum(['none', 'occasional', 'frequent']).catch('occasional'),
  useCustomerName: z.boolean().catch(true),
  humor: z.boolean().catch(false),
  phrasesToAvoid: z.array(z.string()).catch([]),
  phrasesToUse: z.array(z.string()).catch([]),
  rudeCustHandling: z.enum(['firm', 'soft', 'redirect']).catch('soft'),
  offLimitTopics: z.array(z.string()).catch([]),
  fallbackPhrase: z.string().catch(''),
})

const notifPrefsSchema = z.object({
  newBooking: z.boolean().catch(true),
  firstTimeCustomer: z.boolean().catch(true),
  cancellation: z.boolean().catch(true),
  reschedule: z.boolean().catch(false),
  noShow: z.boolean().catch(true),
  upsetLanguage: z.boolean().catch(true),
})

const handoffSchema = z.object({
  scenarios: z.array(z.string()).catch([]),
  handoffPhrase: z.string().catch(''),
  alternateContact: z.string().nullable().catch(null),
})

const bookingEdgeCasesSchema = z.object({
  sameDayAllowed: z.boolean().catch(true),
  sameDayCutoffHour: z.number().nullable().catch(null),
  walkInsAccepted: z.boolean().catch(false),
  backToBackAllowed: z.boolean().catch(true),
  pricingCommunication: z.enum(['state', 'hide', 'on_request']).catch('state'),
  depositInfo: z.string().nullable().catch(null),
})

const automatedMessagesSchema = z.object({
  booking_confirmation:    z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
  reminder_24h:            z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
  reminder_1h:             z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
  rescheduled_confirmation:z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
  post_appointment:        z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
  review_request:          z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
  no_show:                 z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
  first_booking_welcome:   z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
  cancellation_ack:        z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
  waitlist_offer:          z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
  payment_request:         z.object({ enabled: z.boolean(), body: z.string(), delayMinutes: z.number().optional() }),
})

const faqSchema = z.object({
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })).min(1).max(12),
})

const openQuestionSchema = z.object({
  type: z.enum(['faq', 'style_rule', 'notification_rule', 'escalation_rule', 'policy_change', 'unsupported']),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  unsupportedReason: z.string().optional(),
  faqEntry: z.object({ question: z.string(), answer: z.string() }).optional(),
  styleAddition: z.string().optional(),
  notificationEvent: z.string().optional(),
  escalationKeyword: z.string().optional(),
  policyField: z.string().optional(),
  policyValue: z.string().optional(),
})

// ── LLM calls ─────────────────────────────────────────────────────────────────

async function extractCommStyle(text: string, lang: 'he' | 'en'): Promise<CommunicationStyle | null> {
  const system = `Extract communication style preferences from a business owner's description. Return JSON matching the schema exactly. Language context: ${lang}.
offLimitTopics and fallbackPhrase should be empty/blank if not mentioned — they are collected in a later step.`
  return (await callJson(system, text, commStyleSchema)) as unknown as CommunicationStyle | null
}

async function extractNotifPrefs(text: string): Promise<NotificationPreferences | null> {
  const lower = text.toLowerCase()
  const all = /all|everything|כל|הכל/.test(lower)
  const none = /none|nothing|כלום|אף/.test(lower)
  if (all) return { newBooking: true, firstTimeCustomer: true, cancellation: true, reschedule: true, noShow: true, upsetLanguage: true }
  if (none) return { newBooking: false, firstTimeCustomer: false, cancellation: false, reschedule: false, noShow: false, upsetLanguage: false }
  return (await callJson(
    'Extract notification preferences from a business owner\'s message. Return JSON with boolean fields: newBooking, firstTimeCustomer, cancellation, reschedule, noShow, upsetLanguage. Default to true if mentioned, false if not mentioned.',
    text,
    notifPrefsSchema,
  )) as unknown as NotificationPreferences | null
}

async function extractHandoffBehavior(text: string, businessName: string): Promise<HandoffBehavior | null> {
  return (await callJson(
    `Extract handoff/escalation preferences from a business owner's message for "${businessName}". Return JSON with: scenarios (array of trigger descriptions), handoffPhrase (what to say to customer), alternateContact (phone/email or null).`,
    text,
    handoffSchema,
  )) as unknown as HandoffBehavior | null
}

async function extractBookingEdgeCases(text: string): Promise<BookingEdgeCases | null> {
  return (await callJson(
    'Extract booking edge case rules from a business owner\'s message. Return JSON with: sameDayAllowed (bool), sameDayCutoffHour (0-23 or null), walkInsAccepted (bool), backToBackAllowed (bool), pricingCommunication ("state"|"hide"|"on_request"), depositInfo (string or null).',
    text,
    bookingEdgeCasesSchema,
  )) as unknown as BookingEdgeCases | null
}

async function generateAutomatedMessages(ctx: SkillContext): Promise<AutomatedMessagesConfig | null> {
  const bk = ctx.businessKnowledge
  const lang = ctx.language
  const cs = bk.communicationStyle
  const businessType = ctx.businessKnowledge.services.map((s) => s.name).join(', ') || 'local business'
  const isPostPayment = bk.confirmationGate === 'post_payment'
  const googleReviewNote = ''  // no review URL in skill context — review_request disabled by default

  const system = `You are generating automated WhatsApp message templates for a business PA.

Business: ${ctx.business.name}
Type of services: ${businessType}
Language: ${lang === 'he' ? 'Hebrew (עברית)' : 'English'}
Brand voice: ${bk.brandVoice ?? 'professional and friendly'}
Tone: ${cs ? `${cs.formality}, emoji: ${cs.emojiUse}, humor: ${cs.humor}` : 'warm and professional'}
Cancellation policy: ${Math.round(bk.policies.cancellationCutoffMinutes / 60)}h notice required
${bk.cancellationFeeAmount ? `Cancellation fee: ${bk.cancellationFeeAmount} ${bk.cancellationFeeCurrency ?? ''}` : 'No cancellation fee'}
Payment: ${isPostPayment ? `post-payment via ${bk.paymentMethod ?? 'method TBD'}` : 'immediate confirmation, no upfront payment'}
Google review URL: ${googleReviewNote || 'not available — disable review_request'}

Generate all 11 message templates as JSON. Each template: { enabled: boolean, body: string, delayMinutes?: number }.
Rules:
- All text must be in ${lang === 'he' ? 'Hebrew' : 'English'}
- booking_confirmation: enabled true, sent immediately, confirm service/date/time
- reminder_24h: enabled true, delayMinutes irrelevant (scheduled separately)
- reminder_1h: enabled true
- rescheduled_confirmation: enabled true
- post_appointment: enabled true, delayMinutes: 60 (1h after appointment)
- review_request: enabled false (no URL provided)
- no_show: enabled true, delayMinutes: 30
- first_booking_welcome: enabled true
- cancellation_ack: enabled true, mention policy and fee if applicable
- waitlist_offer: enabled true
- payment_request: enabled ${isPostPayment}, only relevant if post-payment mode
- Keep bodies short and WhatsApp-friendly (max 3 sentences)
- Use {customerName}, {serviceName}, {date}, {time}, {businessName} as placeholders`

  return (await callJson(system, 'Generate the templates now.', automatedMessagesSchema)) as unknown as AutomatedMessagesConfig | null
}

async function regenerateMessageGroup(
  ctx: SkillContext,
  state: BksState,
  feedback: string,
): Promise<AutomatedMessagesConfig | null> {
  const group = state.messageReviewGroup ?? 0
  const keys = MESSAGE_GROUPS[group]
  if (!keys || !state.automatedMessages) return null

  const current = keys.map((k) => `${k}: "${state.automatedMessages![k].body}"`).join('\n')
  const system = `Update these WhatsApp message templates based on the owner's feedback. Language: ${ctx.language === 'he' ? 'Hebrew' : 'English'}.
Current templates:\n${current}
Return the same JSON structure as before (all 11 keys) but with updated bodies for the keys in this group: ${keys.join(', ')}`

  const updated = await callJson(system, feedback, automatedMessagesSchema)
  if (!updated) return null
  // Merge: only replace the keys in this group
  return { ...state.automatedMessages, ...updated } as AutomatedMessagesConfig
}

async function generateFaqs(ctx: SkillContext, state: BksState): Promise<Array<{ question: string; answer: string }> | null> {
  const bk = ctx.businessKnowledge
  const lang = ctx.language
  const services = bk.services.map((s) => `${s.name}: ${s.narrative ?? 'no description'}`).join('\n')
  const cs = bk.communicationStyle

  const system = `Generate 5–8 FAQ question-answer pairs for a WhatsApp business assistant.

Business: ${ctx.business.name}
Brand voice: ${bk.brandVoice ?? 'friendly and professional'}
Tone: ${cs ? cs.formality : 'friendly'}
Services:\n${services}
Cancellation policy: ${Math.round(bk.policies.cancellationCutoffMinutes / 60)}h notice required
${bk.cancellationFeeAmount ? `Cancellation fee: ${bk.cancellationFeeAmount} ${bk.cancellationFeeCurrency ?? ''}` : ''}
Payment: ${bk.confirmationGate === 'post_payment' ? `via ${bk.paymentMethod}` : 'confirmed immediately'}
Raw FAQ input from owner: ${state.rawFaqInput ?? 'none provided'}

Rules:
- Language: ${lang === 'he' ? 'Hebrew (עברית)' : 'English'}
- Cover: cancellation policy, pricing, how to book, what to bring, what makes this business special
- Incorporate owner's raw FAQ input where relevant
- Keep answers to 1–2 sentences
- Return JSON: { "faqs": [{ "question": "...", "answer": "..." }] }`

  const result = await callJson(system, 'Generate the FAQs now.', faqSchema)
  return result?.faqs ?? null
}

async function classifyOpenQuestion(text: string): Promise<z.infer<typeof openQuestionSchema> | null> {
  const system = `Classify a business owner's freeform request into one of these categories:
- faq: adding a new FAQ entry (extract the question and answer)
- style_rule: a rule about how the PA should communicate (extract the rule text)
- notification_rule: when the owner wants to be notified (extract the event)
- escalation_rule: a keyword/situation to escalate to the owner (extract the keyword)
- policy_change: a change to a known configurable policy (extract field and value)
- unsupported: something that requires developer work to implement

Confidence 0-1. If confidence < 0.65, classify as unsupported.
Return JSON matching the schema.`
  return callJson(system, text, openQuestionSchema)
}

// Turn-intent triage now lives in the shared module (src/shared/turn-intent.ts)
// so every setup flow handles interjections the same way. We just wire callJson
// + this skill's save/present callbacks into it (see dispatchStep).

// ── Cancellation/payment parsing helpers ───────────────────────────────────────

function parseCancellationUpdate(text: string): { cutoffHours?: number; feeAmount?: number; feeCurrency?: string } {
  const result: { cutoffHours?: number; feeAmount?: number; feeCurrency?: string } = {}
  const hoursMatch = text.match(/(\d+)\s*(?:שעות|hours?|h\b)/i)
  if (hoursMatch) result.cutoffHours = parseInt(hoursMatch[1]!, 10)
  const feeMatch = text.match(/(\d+(?:\.\d+)?)\s*(₪|nis|ils|eur|usd|gbp|שקל)?/i)
  if (feeMatch && /fee|עמלה|charge/.test(text.toLowerCase())) {
    result.feeAmount = parseFloat(feeMatch[1]!)
    result.feeCurrency = feeMatch[2]?.toUpperCase() ?? 'ILS'
  }
  return result
}

// ── Main skill ─────────────────────────────────────────────────────────────────

export const businessKnowledgeSetupSkill: Skill = {
  name: 'business-knowledge-setup',

  canHandle(ctx: SkillContext): boolean {
    if (ctx.workflowState?.skillName === 'business-knowledge-setup') return true
    if (ctx.caller.role !== 'manager') return false
    // Broad "business knowledge" triggers PLUS the rich per-section phrasings the Branch-3
    // orchestrator has no tool for (communication style, handoff behaviour, automated-message
    // wording). Tokens are chosen to line up with detectStartStep so the matched message routes to
    // the right section. Deliberately NOT here: "escalat" (owner escalation rules are a dedicated
    // orchestrator tool → businesses.escalationRules), and bare "message"/"reminder"/"notification"
    // (would hijack the reminder-timing / proactive-feature / notification tools).
    return /business info|brand voice|update.*faq|update.*info|business setup|update.*brand|business knowledge|communication style|tone of voice|handoff|automated message|message template|עדכן עסק|עדכן מידע|ידע עסקי|הגדרות עסק|עדכן פרטים|סגנון תקשורת|טון דיבור|מסירה|הודעות אוטומטיות|תבניות הודעות/i.test(ctx.message.text)
  },

  async handle(ctx: SkillContext): Promise<SkillOutcome> {
    try {
      // ── Start or resume ──────────────────────────────────────────────────────
      if (!ctx.workflowState) {
        const startStep = detectStartStep(ctx.message.text)
        const initialState: BksState = { skippedSteps: [] }

        // Pre-populate from existing knowledge for re-runs
        if (ctx.businessKnowledge.brandVoice) initialState.brandVoice = ctx.businessKnowledge.brandVoice
        if (ctx.businessKnowledge.communicationStyle) initialState.communicationStyle = ctx.businessKnowledge.communicationStyle
        if (ctx.businessKnowledge.notificationPreferences) initialState.notificationPrefs = ctx.businessKnowledge.notificationPreferences
        if (ctx.businessKnowledge.handoffBehavior) initialState.handoffBehavior = ctx.businessKnowledge.handoffBehavior
        if (ctx.businessKnowledge.automatedMessagesConfig) initialState.automatedMessages = ctx.businessKnowledge.automatedMessagesConfig

        // Seed website/GMB awareness so offer steps can skip if already set up
        initialState.websiteAlreadyExists = !!(ctx.businessKnowledge.websiteUrl || ctx.businessKnowledge.websitePreviewUrl)
        initialState.gmbAlreadyExists = !!(ctx.businessKnowledge.gmbProfileUrl)

        await ctx.workflow.create('business-knowledge-setup', startStep, initialState as unknown as Record<string, unknown>)
        const question = Q[startStep as Step](ctx, initialState)
        return { handled: true, reply: question, sessionComplete: false, skillName: this.name }
      }

      const wf = ctx.workflowState
      const state = (wf.state as unknown as BksState)
      const step = wf.step as Step

      // ── Universal: CANCEL ───────────────────────────────────────────────────
      if (isCancelText(ctx.message.text) && step !== 'open-question') {
        await ctx.workflow.complete()
        const reply = ctx.language === 'he'
          ? '✅ שמרתי את כל מה שאספנו עד כה. תוכל לחזור ולהשלים בכל עת.'
          : '✅ Saved everything collected so far. You can come back to complete it any time.'
        return { handled: true, reply, sessionComplete: true, skillName: this.name }
      }

      // ── Step dispatch ────────────────────────────────────────────────────────
      return await dispatchStep(step, ctx, state, wf.version, this.name)
    } catch {
      return {
        handled: true,
        reply: ctx.language === 'he' ? 'אירעה שגיאה. נסה שוב.' : 'Something went wrong. Please try again.',
        sessionComplete: false,
        skillName: this.name,
      }
    }
  },
}

// ── Step dispatcher ───────────────────────────────────────────────────────────

async function dispatchStep(
  step: Step,
  ctx: SkillContext,
  state: BksState,
  version: number,
  skillName: string,
): Promise<SkillOutcome> {
  const lang = ctx.language
  const text = ctx.message.text.trim()

  async function advance(nextStep: Step | 'done', newState: BksState): Promise<void> {
    if (nextStep === 'done') {
      await ctx.workflow.complete()
    } else {
      await ctx.workflow.advance(nextStep, newState as unknown as Record<string, unknown>)
    }
  }

  async function skip(nextStep: Step | 'done', newState: BksState, reply?: string): Promise<SkillOutcome> {
    const ns = { ...state, skippedSteps: [...(state.skippedSteps ?? []), step], ...newState }
    const done = nextStep === 'done'
    if (done) {
      await ctx.workflow.complete()
    } else {
      await ctx.workflow.advance(nextStep, ns as unknown as Record<string, unknown>)
    }
    return {
      handled: true,
      reply: reply ?? (done ? completionReply(lang) : Q[nextStep as Step](ctx, ns)),
      sessionComplete: done,
      skillName,
    }
  }

  // ── Universal interjection / deferral handling (applies to every step) ──────
  // A human front-desk person, asked anything, can field "sure, but first let me
  // tell you about the team", a side question, or a volunteered fact — then return
  // to what they were doing. This gives the skill that, uniformly: triage the turn;
  // if it isn't a direct answer, capture/answer it and RE-PRESENT the current step
  // without advancing. Bare approve/skip/cancel words skip triage (fast path), and
  // any triage failure falls through to the normal per-step handler below.
  // Closed/decision steps only expect approve/skip/edit, so a free-form message
  // there is genuinely an interjection. The open-ended info-gathering steps
  // (brand-voice … faq-collect, open-question) already accept arbitrary input and
  // have their own richer handling, so we leave them untouched to avoid regressing.
  const TRIAGE_STEPS = new Set<Step>(['cancellation-payment-confirm', 'message-review', 'faq-review', 'website-offer', 'gmb-offer'])
  if (TRIAGE_STEPS.has(step)) {
    const bare = isBareControl(text, (t) => isApproveText(t) || isSkipText(t) || isCancelText(t))
    if (text.length > 0 && !bare) {
      const stepAsk = (Q[step]?.(ctx, state) ?? '').replace(/\s+/g, ' ').slice(0, 240)
      const intent = await callJson(buildTurnIntentPrompt(stepAsk), text, turnIntentSchema)
      const reply = await resolveInterjection(intent, {
        lang,
        presentStep: () => Q[step]?.(ctx, state) ?? '',
        saveFaq: async (q, a) => {
          const updated = [...(state.generatedFaqs ?? []), { question: q, answer: a }]
          await ctx.saveFAQs(updated)
          state.generatedFaqs = updated
        },
        saveNote: async (t) => { await ctx.deferFeatureRequest(t) },
      })
      if (reply) return { handled: true, reply, sessionComplete: false, skillName }
    }
  }

  switch (step) {
    // ── 1. brand-voice ─────────────────────────────────────────────────────────
    case 'brand-voice': {
      if (isSkipText(text)) return skip('communication-style', {})
      const brandVoice = text
      await ctx.saveBrandVoice(brandVoice)
      const ns: BksState = { ...state, brandVoice }
      await advance('communication-style', ns)
      return { handled: true, reply: Q['communication-style'](ctx, ns), sessionComplete: false, skillName }
    }

    // ── 2. communication-style ─────────────────────────────────────────────────
    case 'communication-style': {
      if (isSkipText(text)) return skip('notification-prefs', {})
      const extracted = await extractCommStyle(text, lang)
      const cs: CommunicationStyle = extracted ?? {
        formality: 'casual', emojiUse: 'occasional', useCustomerName: true,
        humor: false, phrasesToAvoid: [], phrasesToUse: [],
        rudeCustHandling: 'soft', offLimitTopics: [], fallbackPhrase: '',
      }
      await ctx.saveCommunicationStyle(cs)
      const ns: BksState = { ...state, communicationStyle: cs }
      await advance('notification-prefs', ns)
      return { handled: true, reply: Q['notification-prefs'](ctx, ns), sessionComplete: false, skillName }
    }

    // ── 3. notification-prefs ─────────────────────────────────────────────────
    case 'notification-prefs': {
      if (isSkipText(text)) return skip('handoff-rules', {})
      const extracted = await extractNotifPrefs(text)
      const prefs: NotificationPreferences = extracted ?? {
        newBooking: true, firstTimeCustomer: true, cancellation: true,
        reschedule: false, noShow: true, upsetLanguage: true,
      }
      await ctx.saveNotificationPreferences(prefs)
      const ns: BksState = { ...state, notificationPrefs: prefs }
      await advance('handoff-rules', ns)
      return { handled: true, reply: Q['handoff-rules'](ctx, ns), sessionComplete: false, skillName }
    }

    // ── 4. handoff-rules ──────────────────────────────────────────────────────
    case 'handoff-rules': {
      if (isSkipText(text)) return skip('cancellation-payment-confirm', {})
      const extracted = await extractHandoffBehavior(text, ctx.business.name)
      const behavior: HandoffBehavior = extracted ?? { scenarios: [], handoffPhrase: '', alternateContact: null }
      await ctx.saveHandoffBehavior(behavior)
      const ns: BksState = { ...state, handoffBehavior: behavior }
      await advance('cancellation-payment-confirm', ns)
      return { handled: true, reply: Q['cancellation-payment-confirm'](ctx, ns), sessionComplete: false, skillName }
    }

    // ── 5. cancellation-payment-confirm ───────────────────────────────────────
    case 'cancellation-payment-confirm': {
      if (isApproveText(text)) {
        // No changes — move on
        const ns: BksState = { ...state }
        await advance('service-narratives', ns)
        return { handled: true, reply: Q['service-narratives'](ctx, ns), sessionComplete: false, skillName }
      }
      if (isSkipText(text)) return skip('service-narratives', {})

      // Parse changes
      const updates = parseCancellationUpdate(text)
      if (updates.cutoffHours !== undefined) {
        await ctx.saveCancellationCutoffMinutes(updates.cutoffHours * 60)
      }
      if (updates.feeAmount !== undefined) {
        const currency = updates.feeCurrency ?? ctx.business.currency
        await ctx.saveCancellationFee(updates.feeAmount, currency)
      }
      const ns: BksState = {
        ...state,
        ...(updates.feeAmount !== undefined ? { cancellationFeeAmount: updates.feeAmount } : {}),
        ...(updates.feeCurrency !== undefined ? { cancellationFeeCurrency: updates.feeCurrency } : {}),
      }
      await advance('service-narratives', ns)
      const confirm = lang === 'he' ? '✅ הגדרות עודכנו.' : '✅ Settings updated.'
      return { handled: true, reply: confirm + '\n\n' + Q['service-narratives'](ctx, ns), sessionComplete: false, skillName }
    }

    // ── 6. service-narratives (loop) ──────────────────────────────────────────
    case 'service-narratives': {
      const done = state.serviceProgress ?? []
      const next = ctx.businessKnowledge.services.find((s) => !done.includes(s.id))

      if (!next) {
        // All services done — advance
        const ns: BksState = { ...state }
        await advance('booking-edge-cases', ns)
        return { handled: true, reply: Q['booking-edge-cases'](ctx, ns), sessionComplete: false, skillName }
      }

      if (!isSkipText(text)) {
        // Save narrative + intake notes to DB
        const parts = text.split(/\n\n|----/)
        const narrative = parts[0]?.trim() ?? text
        const intakeNotes = parts[1]?.trim() ?? ''
        await ctx.saveServiceNarrative(next.id, narrative)
        if (intakeNotes) await ctx.saveServiceIntakeNotes(next.id, intakeNotes)
      }

      const newDone = [...done, next.id]
      const ns: BksState = { ...state, serviceProgress: newDone }

      // Check if more services remain
      const remaining = ctx.businessKnowledge.services.filter((s) => !newDone.includes(s.id))
      if (remaining.length === 0) {
        await advance('booking-edge-cases', ns)
        return { handled: true, reply: Q['booking-edge-cases'](ctx, ns), sessionComplete: false, skillName }
      }

      // Stay on service-narratives, advance state
      await ctx.workflow.advance('service-narratives', ns as unknown as Record<string, unknown>)
      const nextService = remaining[0]!
      const priceStr = nextService.price ? ` · ${nextService.price} ${nextService.currency}` : ''
      const reply = lang === 'he'
        ? `✅ שמרתי. עכשיו — *${nextService.name}* (${nextService.durationMinutes} דקות${priceStr}):\n\nמה הלקוח צריך לדעת? מה להביא/להכין/להימנע?\n\n(ענה *דלג* כדי לדלג)`
        : `✅ Saved. Now — *${nextService.name}* (${nextService.durationMinutes} min${priceStr}):\n\nWhat should the customer know? Anything to bring/prepare/avoid?\n\n(Reply *skip* to skip)`
      return { handled: true, reply, sessionComplete: false, skillName }
    }

    // ── 7. booking-edge-cases ─────────────────────────────────────────────────
    case 'booking-edge-cases': {
      if (isSkipText(text)) return skip('off-limits', {})
      const extracted = await extractBookingEdgeCases(text)
      const cases: BookingEdgeCases = extracted ?? {
        sameDayAllowed: true, sameDayCutoffHour: null, walkInsAccepted: false,
        backToBackAllowed: true, pricingCommunication: 'state', depositInfo: null,
      }
      await ctx.saveBookingEdgeCases(cases)
      const ns: BksState = { ...state, bookingEdgeCases: cases }
      await advance('off-limits', ns)
      return { handled: true, reply: Q['off-limits'](ctx, ns), sessionComplete: false, skillName }
    }

    // ── 8. off-limits ─────────────────────────────────────────────────────────
    case 'off-limits': {
      if (isSkipText(text)) return skip('faq-collect', {})

      // Parse topics and fallback phrase from free text; merge into communicationStyle
      const existing = state.communicationStyle ?? {
        formality: 'casual', emojiUse: 'occasional', useCustomerName: true,
        humor: false, phrasesToAvoid: [], phrasesToUse: [],
        rudeCustHandling: 'soft', offLimitTopics: [], fallbackPhrase: '',
      }

      const lines = text.split(/\n|,/).map((l) => l.trim()).filter(Boolean)
      const fallbackLine = lines.find((l) => /say|tell|omer|לומר|להגיד/i.test(l))
      const topics = lines.filter((l) => l !== fallbackLine && l.length > 2)

      const updated: CommunicationStyle = {
        ...existing,
        offLimitTopics: topics.length > 0 ? topics : existing.offLimitTopics,
        fallbackPhrase: fallbackLine ?? existing.fallbackPhrase,
      }
      await ctx.saveCommunicationStyle(updated)
      const ns: BksState = { ...state, communicationStyle: updated }
      await advance('faq-collect', ns)
      return { handled: true, reply: Q['faq-collect'](ctx, ns), sessionComplete: false, skillName }
    }

    // ── 9. faq-collect → immediately generate messages ─────────────────────────
    case 'faq-collect': {
      if (isSkipText(text)) {
        const ns: BksState = { ...state, rawFaqInput: '' }
        return await runMessageGeneration(ctx, ns, skillName)
      }
      const ns: BksState = { ...state, rawFaqInput: text }
      return await runMessageGeneration(ctx, ns, skillName)
    }

    // ── 10. message-review ────────────────────────────────────────────────────
    case 'message-review': {
      // Defensive: if we landed here without generated messages (e.g. a prior
      // generation failure advanced us in anyway), don't loop forever on the
      // "preparing your messages..." placeholder — skip straight to FAQs.
      if (!state.automatedMessages) {
        return await runFaqGeneration(ctx, state, skillName)
      }
      const group = state.messageReviewGroup ?? 0
      const totalGroups = 2 // compressed from 4 to 2 groups
      const regenCount = state.messageReviewRegenCount ?? 0

      if (isApproveText(text) || regenCount >= 2) {
        const nextGroup = group + 1
        if (nextGroup >= totalGroups) {
          // All groups approved — save config and generate FAQs
          if (state.automatedMessages) await ctx.saveAutomatedMessagesConfig(state.automatedMessages)
          return await runFaqGeneration(ctx, state, skillName)
        }
        const ns: BksState = { ...state, messageReviewGroup: nextGroup, messageReviewRegenCount: 0 }
        await ctx.workflow.advance('message-review', ns as unknown as Record<string, unknown>)
        return { handled: true, reply: buildMessageReviewPrompt(ctx, ns), sessionComplete: false, skillName }
      }

      if (isSkipText(text)) {
        // Skip remaining message review → go to FAQ generation
        if (state.automatedMessages) await ctx.saveAutomatedMessagesConfig(state.automatedMessages)
        return await runFaqGeneration(ctx, state, skillName)
      }

      // Manager wants changes — regenerate this group (capped at 2 attempts)
      const updated = await regenerateMessageGroup(ctx, state, text)
      const finalMessages = updated ?? state.automatedMessages
      const ns: BksState = {
        ...state,
        ...(finalMessages !== undefined ? { automatedMessages: finalMessages } : {}),
        messageReviewRegenCount: regenCount + 1,
      }
      await ctx.workflow.advance('message-review', ns as unknown as Record<string, unknown>)
      const editConfirm = lang === 'he' ? '✅ עדכנתי. בדוק שוב:\n\n' : '✅ Updated. Review again:\n\n'
      return { handled: true, reply: editConfirm + buildMessageReviewPrompt(ctx, ns), sessionComplete: false, skillName }
    }

    // ── 11. faq-review ────────────────────────────────────────────────────────
    case 'faq-review': {
      if (isApproveText(text) || isSkipText(text)) {
        if (state.generatedFaqs && state.generatedFaqs.length > 0) {
          await ctx.saveFAQs(state.generatedFaqs)
        }
        const ns: BksState = { ...state }
        await advance('open-question', ns)
        return { handled: true, reply: Q['open-question'](ctx, ns), sessionComplete: false, skillName }
      }

      // Manager wants changes — regenerate FAQs with feedback
      const newFaqs = await generateFaqsWithFeedback(ctx, state, text)
      const finalFaqs = newFaqs ?? state.generatedFaqs
      const ns: BksState = { ...state, ...(finalFaqs !== undefined ? { generatedFaqs: finalFaqs } : {}) }
      await ctx.workflow.advance('faq-review', ns as unknown as Record<string, unknown>)
      const editConfirm = lang === 'he' ? '✅ עדכנתי. בדוק שוב:\n\n' : '✅ Updated. Review again:\n\n'
      return { handled: true, reply: editConfirm + buildFaqReviewPrompt(ctx, ns), sessionComplete: false, skillName }
    }

    // ── 12. open-question (loop) ──────────────────────────────────────────────
    case 'open-question': {
      const count = state.openQuestionCount ?? 0

      if (isCancelText(text) || isSkipText(text) || count >= 3) {
        return await runWebsiteOffer(ctx, state, skillName)
      }

      // A bare lead-in ("I want to tell you about our instructors") carries no
      // concrete fact yet — don't misfile it as a deferred feature request and
      // brush the owner off. Invite the detail; the next turn carries the content.
      const isLeadIn = /(?:אני\s+)?רוצה\s+(?:ל)?(?:ספר|הסביר|שתף|הוסיף)|תן\s+לי\s+(?:ל)?(?:ספר|הסביר)|(?:let me|i(?:'?d)?\s+(?:want|like)\s+to)\s+(?:tell|explain|share|add)/i
      if (isLeadIn.test(text) && text.trim().length < 60) {
        const reply = lang === 'he' ? 'בכיף, ספר לי — אני מקשיב.' : "Sure — go ahead, I'm listening."
        return { handled: true, reply, sessionComplete: false, skillName }
      }

      const classification = await classifyOpenQuestion(text)

      if (!classification || classification.confidence < 0.65 || classification.type === 'unsupported') {
        // Genuinely unclassifiable — capture it, but acknowledge honestly. Do NOT
        // claim it was "passed to the team" / that they'll get a confirmation; the
        // owner is usually just sharing business context, not filing a ticket.
        await ctx.deferFeatureRequest(text)
        const reply = lang === 'he'
          ? `תודה, רשמתי לי את זה.\n\n${Q['open-question'](ctx, state)}`
          : `Thanks, I've noted that.\n\n${Q['open-question'](ctx, state)}`
        const ns: BksState = { ...state, openQuestionCount: count + 1 }
        await ctx.workflow.advance('open-question', ns as unknown as Record<string, unknown>)
        return { handled: true, reply, sessionComplete: false, skillName }
      }

      let confirm = ''

      switch (classification.type) {
        case 'faq':
          if (classification.faqEntry) {
            const existing = state.generatedFaqs ?? []
            const updated = [...existing, classification.faqEntry]
            await ctx.saveFAQs(updated)
            state.generatedFaqs = updated
            confirm = lang === 'he' ? '✅ הוספתי לשאלות ותשובות.' : '✅ Added to FAQs.'
          }
          break

        case 'style_rule':
          if (classification.styleAddition && state.communicationStyle) {
            const updated: CommunicationStyle = {
              ...state.communicationStyle,
              phrasesToUse: [...(state.communicationStyle.phrasesToUse ?? []), classification.styleAddition],
            }
            await ctx.saveCommunicationStyle(updated)
            state.communicationStyle = updated
          }
          confirm = lang === 'he' ? '✅ הוספתי לכללי הסגנון.' : '✅ Added to communication style rules.'
          break

        case 'notification_rule':
          confirm = lang === 'he' ? '✅ רשמתי.' : '✅ Noted.'
          break

        case 'escalation_rule':
          confirm = lang === 'he' ? '✅ הוספתי לכללי ההעברה.' : '✅ Added to handoff rules.'
          break

        case 'policy_change':
          confirm = lang === 'he' ? '✅ רשמתי לבדיקה.' : '✅ Noted for review.'
          break
      }

      const ns: BksState = { ...state, openQuestionCount: count + 1 }
      await ctx.workflow.advance('open-question', ns as unknown as Record<string, unknown>)
      return {
        handled: true,
        reply: (confirm ? confirm + '\n\n' : '') + Q['open-question'](ctx, ns),
        sessionComplete: false,
        skillName,
      }
    }

    // ── 13. website-offer ─────────────────────────────────────────────────────
    case 'website-offer': {
      if (state.websiteAlreadyExists) {
        return await runGmbOffer(ctx, state, skillName)
      }

      if (isApproveText(text)) {
        try {
          await ctx.workflow.create('website-builder', 'requirements-gather', {})
        } catch {
          // WorkflowConflictError — website-builder already exists, treat as created
        }
        await ctx.workflow.complete()
        const bridge = lang === 'he'
          ? 'מעולה! בואנו נבנה את האתר שלך. מה סגנון העיצוב שאתה מעדיף?'
          : "Great! Let's build your website. What design style do you prefer?"
        return { handled: true, reply: bridge, sessionComplete: true, skillName }
      }

      if (isSkipText(text) || /no|לא/.test(text.toLowerCase())) {
        return await runGmbOffer(ctx, state, skillName)
      }

      // Re-ask with LLM-generated natural sentence
      const offerMsg = await generateOfferMessage(ctx, 'website')
      return { handled: true, reply: offerMsg, sessionComplete: false, skillName }
    }

    // ── 14. gmb-offer ─────────────────────────────────────────────────────────
    case 'gmb-offer': {
      if (state.gmbAlreadyExists) {
        await ctx.workflow.complete()
        return { handled: true, reply: completionReply(lang), sessionComplete: true, skillName }
      }

      if (isApproveText(text)) {
        try {
          await ctx.workflow.create('google-business-setup', 'check-existing', {})
        } catch {
          // WorkflowConflictError — already exists
        }
        await ctx.workflow.complete()
        const bridge = lang === 'he'
          ? 'בואנו נגדיר את הפרופיל שלך ב-Google Business.'
          : "Let's set up your Google Business profile."
        return { handled: true, reply: bridge, sessionComplete: true, skillName }
      }

      if (isSkipText(text) || /no|לא/.test(text.toLowerCase())) {
        await ctx.workflow.complete()
        return { handled: true, reply: completionReply(lang), sessionComplete: true, skillName }
      }

      const offerMsg = await generateOfferMessage(ctx, 'gmb')
      return { handled: true, reply: offerMsg, sessionComplete: false, skillName }
    }
  }
}

// ── Generation helpers ────────────────────────────────────────────────────────

async function runMessageGeneration(ctx: SkillContext, state: BksState, skillName: string): Promise<SkillOutcome> {
  const lang = ctx.language

  const generated = await generateAutomatedMessages(ctx)

  if (!generated) {
    // Generation failed — do NOT enter message-review. Without generated messages
    // that step has nothing to show and loops forever on the "preparing your
    // messages..." placeholder (every reply read as an edit). Skip straight to FAQ
    // generation, mirroring runFaqGeneration's own failure handling.
    const skipped = await runFaqGeneration(ctx, { ...state, messageReviewGroup: 0 }, skillName)
    const prefix = lang === 'he'
      ? 'לא הצלחתי לייצר הודעות אוטומטיות כרגע, נמשיך הלאה.\n\n'
      : "Couldn't generate automated messages right now — moving on.\n\n"
    return skipped.handled ? { ...skipped, reply: prefix + skipped.reply } : skipped
  }

  const thinking = lang === 'he'
    ? '⏳ מכין את ההודעות האוטומטיות שלך...'
    : '⏳ Generating your automated message templates...'
  const ns: BksState = { ...state, automatedMessages: generated, messageReviewGroup: 0 }
  await ctx.workflow.advance('message-review', ns as unknown as Record<string, unknown>)
  return {
    handled: true,
    reply: thinking + '\n\n' + buildMessageReviewPrompt(ctx, ns),
    sessionComplete: false,
    skillName,
  }
}

async function runFaqGeneration(ctx: SkillContext, state: BksState, skillName: string): Promise<SkillOutcome> {
  const lang = ctx.language
  const faqs = await generateFaqs(ctx, state)
  const ns: BksState = { ...state, generatedFaqs: faqs ?? [] }

  if (!faqs || faqs.length === 0) {
    // Skip faq-review entirely — advance straight to open-question in one call
    await ctx.workflow.advance('open-question', ns as unknown as Record<string, unknown>)
    return {
      handled: true,
      reply: (lang === 'he' ? 'לא הצלחתי לייצר שאלות ותשובות. ממשיכים.\n\n' : "Couldn't generate FAQs. Moving on.\n\n") +
        Q['open-question'](ctx, ns),
      sessionComplete: false,
      skillName,
    }
  }

  await ctx.workflow.advance('faq-review', ns as unknown as Record<string, unknown>)
  return { handled: true, reply: buildFaqReviewPrompt(ctx, ns), sessionComplete: false, skillName }
}

async function generateFaqsWithFeedback(
  ctx: SkillContext,
  state: BksState,
  feedback: string,
): Promise<Array<{ question: string; answer: string }> | null> {
  const current = (state.generatedFaqs ?? []).map((f, i) => `${i + 1}. Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
  const system = `Update these FAQs based on the owner's feedback. Language: ${ctx.language === 'he' ? 'Hebrew' : 'English'}.
Current FAQs:\n${current}
Return JSON: { "faqs": [{ "question": "...", "answer": "..." }] }`
  const result = await callJson(system, feedback, faqSchema)
  return result?.faqs ?? null
}

function completionReply(lang: 'he' | 'en'): string {
  return lang === 'he'
    ? '✅ *הגדרת הידע העסקי הושלמה!*\n\nשמרתי את כל המידע. ה-PA מוכן לייצג אותך בצורה הטובה ביותר.\n\nאפשר לעדכן כל הגדרה בכל עת — פשוט כתב "עדכן מידע עסקי".'
    : '✅ *Business knowledge setup complete!*\n\nAll information saved. Your PA is ready to represent you at its best.\n\nYou can update any setting at any time — just say "update business info".'
}

async function generateOfferMessage(ctx: SkillContext, type: 'website' | 'gmb'): Promise<string> {
  const systemPrompt = `You are a helpful PA assistant. Generate ONE short natural conversational sentence (no menus, no bullet points, no emoji) offering to help set up the ${type === 'website' ? 'business website' : 'Google Business Profile'} for "${ctx.business.name}". Language: ${ctx.language === 'he' ? 'Hebrew' : 'English'}. Output: the sentence ONLY.`
  const fallback = type === 'website'
    ? (ctx.language === 'he' ? 'רוצה שאבנה לך אתר עכשיו? זה לוקח רק כמה דקות.' : 'Want me to build you a website now? It only takes a few minutes.')
    : (ctx.language === 'he' ? 'רוצה גם להגדיר פרופיל Google Business? כך לקוחות ימצאו אותך בגוגל.' : 'Want to set up your Google Business profile too? That puts you on Google Maps.')
  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: 'Generate the offer message.',
      // Gemini 2.5 Flash "thinks" by default, and those tokens are drawn from
      // maxOutputTokens — a tight 128 budget gets consumed by thinking and the
      // reply comes back truncated (e.g. "רוצה שא"). Disable thinking (valid on
      // Flash) and give the one-liner ample room.
      config: { systemInstruction: systemPrompt, maxOutputTokens: 256, temperature: 0.5, thinkingConfig: { thinkingBudget: 0 } },
    })
    const text = result.text?.trim()
    // Guard against truncated/garbage output: a real offer sentence is a full
    // clause. Anything implausibly short falls back to the hand-written copy.
    if (!text || text.length < 12) return fallback
    return text
  } catch {
    return fallback
  }
}

async function runWebsiteOffer(ctx: SkillContext, state: BksState, skillName: string): Promise<SkillOutcome> {
  if (state.websiteAlreadyExists) {
    return runGmbOffer(ctx, state, skillName)
  }
  const offerMsg = await generateOfferMessage(ctx, 'website')
  const ns: BksState = { ...state }
  await ctx.workflow.advance('website-offer', ns as unknown as Record<string, unknown>)
  return { handled: true, reply: offerMsg, sessionComplete: false, skillName }
}

async function runGmbOffer(ctx: SkillContext, state: BksState, skillName: string): Promise<SkillOutcome> {
  const lang = ctx.language
  if (state.gmbAlreadyExists) {
    await ctx.workflow.complete()
    return { handled: true, reply: completionReply(lang), sessionComplete: true, skillName }
  }
  const offerMsg = await generateOfferMessage(ctx, 'gmb')
  const ns: BksState = { ...state }
  await ctx.workflow.advance('gmb-offer', ns as unknown as Record<string, unknown>)
  return { handled: true, reply: offerMsg, sessionComplete: false, skillName }
}
