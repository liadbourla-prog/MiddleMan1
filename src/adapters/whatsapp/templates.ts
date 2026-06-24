// WhatsApp message-template catalog — the single source of truth for every Meta-approved
// template the PA sends out of the 24-hour customer-service window.
//
// WHY THIS EXISTS
// Templates are owned at the WABA level, and in this product EACH BUSINESS HAS ITS OWN WABA
// (Embedded Signup as a Tech Provider — see ONBOARDING_DESIGN.md §5). So the approved template
// objects must exist inside every business's WABA, not centrally. We author the catalog ONCE
// here, then a provisioning routine replicates this exact set into each business's WABA via the
// Graph API (that build is tracked separately). Workers reference templates by key so the name,
// category, language copy, and positional-variable order all live in one place.
//
// VARIABLES
// Meta templates use positional placeholders {{1}} {{2}} … Anything that differs per recipient
// (customer name, service, business, date, time, amount) MUST be a variable — Meta rejects
// templates that hard-code per-customer data. `params` documents the order; `bodyComponents`
// builds the API `components` array from values supplied in that same order.
//
// CATEGORY
// 'utility'  → transaction/appointment-triggered (cheapest, no per-user cap) — maps to the
//              initiations spine's consentClass 'transactional'.
// 'marketing'→ promotional / re-engagement (charged, per-user frequency cap, opt-out enforced)
//              — maps to consentClass 'promotional'.
//
// LANGUAGE
// Hebrew only for the soft launch. English copy is added as a second translation per template
// name when we expand (each language is its own Meta translation under the same name).

export type TemplateCategory = 'utility' | 'marketing' | 'authentication'

export interface WaTemplateDef {
  /** Meta template name (lowercase, snake_case — the registry's windowPolicy.templateName). */
  name: string
  category: TemplateCategory
  /** Positional variables, in {{1}}..{{n}} order. Length === number of body params. */
  params: string[]
  /** Body copy per language. `{{n}}` placeholders correspond 1:1 to `params`. */
  bodies: { he: string; en?: string }
}

/**
 * The catalog. Keyed by template name. `satisfies` keeps every entry shape-checked while
 * preserving literal keys for `TemplateName`.
 */
export const WA_TEMPLATES = {
  // ── Live today (kept) ───────────────────────────────────────────────────────
  appointment_reminder_24h: {
    name: 'appointment_reminder_24h',
    category: 'utility',
    params: ['service', 'business', 'date', 'time'],
    bodies: { he: 'תזכורת קטנה — {{1}} ב{{2}} מחר ({{3}}) ב-{{4}}. אם משהו השתנה, רק תכתבו לי ונסדר. נתראה!' },
  },
  appointment_reminder_1h: {
    name: 'appointment_reminder_1h',
    category: 'utility',
    params: ['service', 'business', 'time'],
    bodies: { he: 'תזכורת: {{1}} ב-{{2}} בעוד שעה בשעה {{3}}. להתראות!' },
  },
  waitlist_slot_offer: {
    name: 'waitlist_slot_offer',
    category: 'utility',
    params: ['business', 'service', 'date', 'hold_minutes'],
    bodies: { he: 'התפנה מקום! {{2}} ב{{1}} ב-{{3}}. רוצים אותו? רק תגידו לי ואני תופס לכם — שמרתי אותו ל-{{4}} הדקות הקרובות.' },
  },

  // ── Tier 1 — un-muzzle existing workers ─────────────────────────────────────
  payment_dunning_1: {
    name: 'payment_dunning_1',
    category: 'utility',
    params: ['service', 'business'],
    bodies: { he: 'היי! נשאר רק להשלים את התשלום כדי לאשר את {{1}} ב{{2}}. אם נתקלת בבעיה נשמח לעזור 🙂' },
  },
  payment_dunning_2: {
    name: 'payment_dunning_2',
    category: 'utility',
    params: ['service', 'business'],
    bodies: { he: 'מזכירים! {{1}} ב{{2}} עדיין לא מאושר ועלול להשתחרר אם התשלום לא יושלם בקרוב. נשמח אם תוכל/י להשלים את התשלום 🙏' },
  },
  payment_dunning_final: {
    name: 'payment_dunning_final',
    category: 'utility',
    params: ['service', 'business'],
    bodies: { he: 'תזכורת אחרונה: {{1}} ב{{2}} עלול להשתחרר אם התשלום לא יושלם. אם צריך עזרה בכל דבר — פשוט תכתבו לנו 💛' },
  },
  subscription_renewal_7d: {
    name: 'subscription_renewal_7d',
    category: 'utility',
    params: ['plan', 'business', 'date'],
    bodies: { he: 'היי! מזכירים — המנוי "{{1}}" שלך ב{{2}} מתחדש בתאריך {{3}}. אם תרצה/י לשנות משהו — פשוט כתבו לנו 🙂' },
  },
  subscription_renewal_1d: {
    name: 'subscription_renewal_1d',
    category: 'utility',
    params: ['plan', 'business', 'date'],
    bodies: { he: 'היי! תזכורת שהמנוי "{{1}}" שלך ב{{2}} מתחדש מחר ({{3}}). אם תרצה/י לשנות משהו — פשוט כתבו לנו 🙂' },
  },
  no_show_followup: {
    name: 'no_show_followup',
    category: 'utility',
    params: ['business'],
    bodies: { he: 'היי, התגעגענו אליך ב{{1}}. נשמח לעזור לקבוע תור חדש מתי שנוח לך 💛' },
  },
  review_request: {
    name: 'review_request',
    category: 'marketing',
    params: ['business'],
    bodies: { he: 'היי! איך היה ב{{1}}? נשמח אם תוכל/י לשתף חוויה קצרה 🙏' },
  },
  reshuffle_probe: {
    name: 'reshuffle_probe',
    category: 'marketing',
    params: ['business', 'proposed_time'],
    bodies: { he: 'שלום! כאן {{1}} — נשמח לדעת אם יתאים לך להעביר את התור ל-{{2}}? רק אם נוח לך — כלום לא משתנה בלי אישורך.' },
  },
  coldfill_invite: {
    name: 'coldfill_invite',
    category: 'marketing',
    params: ['business', 'service', 'date'],
    bodies: { he: 'היי! התפנה מקום ל{{2}} ב{{1}} ב-{{3}}. אם מתאים לך — רק תכתבו לי ואשמח לשריין 🙂' },
  },
  winback_reengage: {
    name: 'winback_reengage',
    category: 'marketing',
    params: ['business'],
    bodies: { he: 'היי! מ{{1}} — התגעגענו אליך. נשמח לראות אותך שוב בקרוב 😊' },
  },

  // ── Tier 2 — new builds (copy ready; trigger/field built separately) ─────────
  post_appointment_thankyou: {
    name: 'post_appointment_thankyou',
    category: 'utility',
    params: ['service', 'business'],
    bodies: { he: 'תודה שבחרת ב{{2}}! מקווים שנהנית מ{{1}}. נשמח לראות אותך שוב 💛' },
  },
  appointment_reminder_custom: {
    name: 'appointment_reminder_custom',
    category: 'utility',
    params: ['service', 'business', 'date', 'time'],
    bodies: { he: 'תזכורת — {{1}} ב{{2}} בתאריך {{3}} בשעה {{4}}. אם משהו השתנה, רק תכתבו לי ונסדר 🙂' },
  },
  periodic_treatment_due: {
    name: 'periodic_treatment_due',
    category: 'marketing',
    params: ['service', 'business'],
    bodies: { he: 'היי! עבר זמן מאז {{1}} האחרון ב{{2}}. רוצה שנקבע את הבא? 🙂' },
  },
  birthday_greeting: {
    name: 'birthday_greeting',
    category: 'marketing',
    params: ['name', 'business'],
    bodies: { he: 'יום הולדת שמח {{1}}! 🎉 מכל הצוות ב{{2}} — שתהיה לך שנה נהדרת.' },
  },
  contact_meeting_outreach: {
    name: 'contact_meeting_outreach',
    category: 'utility',
    params: ['sender_name', 'proposed_times'],
    bodies: { he: 'שלום! מדבר/ת העוזר/ת של {{1}}. רצינו לתאם פגישה — האם {{2}} מתאים לך? אשמח לתאם מועד נוח.' },
  },

  // ── Broadcast — fixed-shape announcements ───────────────────────────────────
  broadcast_hours_change: {
    name: 'broadcast_hours_change',
    category: 'marketing',
    params: ['business', 'hours'],
    bodies: { he: 'עדכון מ{{1}}: שעות הפעילות החדשות שלנו הן {{2}}. נשמח לראותך!' },
  },
  broadcast_address_change: {
    name: 'broadcast_address_change',
    category: 'marketing',
    params: ['business', 'address'],
    bodies: { he: 'עדכון מ{{1}}: עברנו! הכתובת החדשה שלנו: {{2}}. מחכים לראותך 🙂' },
  },
  broadcast_promo: {
    name: 'broadcast_promo',
    category: 'marketing',
    params: ['business', 'promo'],
    bodies: { he: 'מבצע מיוחד מ{{1}}! {{2}} מהרו לנצל 🎉' },
  },

  // ── Business-originated booking changes the customer didn't initiate ─────────
  reschedule_favor_request: {
    name: 'reschedule_favor_request',
    category: 'utility',
    params: ['business', 'current_time', 'new_time'],
    bodies: { he: 'שלום! כאן {{1}} — יעזור לנו מאוד אם תוכל/י להעביר את התור שלך מ-{{2}} ל-{{3}}. אם זה לא מתאים, אין שום בעיה כמובן 🙏' },
  },
  booking_cancelled_by_business: {
    name: 'booking_cancelled_by_business',
    category: 'utility',
    params: ['business', 'service', 'date'],
    bodies: { he: 'מ{{1}}: התור שלך ל{{2}} בתאריך {{3}} בוטל. אנחנו מצטערים על אי-הנוחות — נשמח לעזור לקבוע מועד חדש 🙏' },
  },
  booking_confirmation: {
    name: 'booking_confirmation',
    category: 'utility',
    params: ['business', 'service', 'date', 'time'],
    bodies: { he: 'מ{{1}}: התור שלך ל{{2}} נקבע בהצלחה לתאריך {{3}} בשעה {{4}}. נתראה!' },
  },
  booking_moved_by_business: {
    name: 'booking_moved_by_business',
    category: 'utility',
    params: ['business', 'current_time', 'new_time'],
    bodies: { he: 'מ{{1}}: התור שלך הועבר מ-{{2}} ל-{{3}}. אם המועד החדש לא מתאים — רק תכתבו לי ונסדר 🙂' },
  },
} satisfies Record<string, WaTemplateDef>

export type TemplateName = keyof typeof WA_TEMPLATES

/**
 * Build the WhatsApp API `components` array (a single BODY component) from positional values.
 * Values MUST be supplied in the same order as the template's `params`. Use this so callers
 * never hand-roll the `{ type: 'body', parameters: [...] }` shape.
 */
export function bodyComponents(values: string[]): Array<{ type: string; parameters: Array<{ type: string; text: string }> }> {
  return [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }]
}
