// Canonical, responsive-only description of the MiddleMan system.
// Single source of truth for "what is MiddleMan?" answers across Branches 2, 3 and 4.
// The PA explains this ONLY when explicitly asked — never proactively, never as marketing.

type Lang = 'he' | 'en'

export type ExplainScope = 'oneliner' | 'brief' | 'full'

// Invariant facts every branch must stay true to. Phrased naturally by the LLM —
// never quoted verbatim, so wording adapts to language, persona and context.
const FACTS: Record<Lang, string> = {
  en: "MiddleMan is a WhatsApp-based platform that gives a local business its own AI personal assistant for booking and scheduling. Everything happens inside WhatsApp — there's no separate app or portal. It handles the calendar, bookings, reminders, cancellations and rescheduling, while the business stays in control.",
  he: 'MiddleMan היא פלטפורמה מבוססת WhatsApp שנותנת לעסק מקומי עוזר אישי חכם משלו לתיאום תורים והזמנות. הכול קורה בתוך WhatsApp — בלי אפליקציה או פורטל נפרד. היא מנהלת את היומן, ההזמנות, התזכורות, הביטולים ושינויי התורים, והשליטה נשארת בידי העסק.',
}

// The responsive-only guard, shared by every branch that can explain the platform.
const GUARD: Record<Lang, string> = {
  en: 'Only describe what MiddleMan is when the user EXPLICITLY asks what system/platform/technology powers this or how it works. Never volunteer it, never market or upsell it, and never raise it during an operational task. Answer the question, then return to what they were doing.',
  he: 'הסבר מהי MiddleMan רק כשהמשתמש שואל במפורש על איזו מערכת/פלטפורמה/טכנולוגיה זה פועל או איך זה עובד. לעולם אל תעלה זאת מיוזמתך, אל תשווק או תקדם אותה, ואל תזכיר אותה תוך כדי משימה תפעולית. ענה לשאלה ואז חזור למה שהם עשו.',
}

const SCOPE_HINT: Record<Lang, Record<ExplainScope, string>> = {
  en: {
    oneliner: 'Answer in ONE short sentence and stay fully in the business persona — give only the single platform fact, no further detail unless pressed again.',
    brief: 'Answer in 1–2 sentences, framed for the operator (it is the platform behind their PA). No marketing.',
    full: 'You may give the complete what-it-is and what-it-does answer.',
  },
  he: {
    oneliner: 'ענה במשפט קצר אחד והישאר לחלוטין בדמות העסק — תן רק את עובדת הפלטפורמה האחת, בלי פירוט נוסף אלא אם נשאלת שוב.',
    brief: 'ענה ב-1–2 משפטים, בניסוח לבעל העסק (זו הפלטפורמה שמאחורי ה-PA שלהם). בלי שיווק.',
    full: 'מותר לתת את התשובה המלאה — מה זה ומה זה עושה.',
  },
}

// Prompt block for branches that inject system-prompt instructions (Branches 2 & 3).
export function middlemanExplainBlock(lang: Lang, scope: ExplainScope): string {
  return `## About the platform (responsive only)
${GUARD[lang]}
Facts to draw from (phrase naturally, never quote verbatim): ${FACTS[lang]}
Length: ${SCOPE_HINT[lang][scope]}`
}

// Customer-facing one-liner fact, used inside the Branch 4 system_explanation situation.
export function middlemanOneLiner(lang: Lang, businessName: string): string {
  return lang === 'he'
    ? `העוזר הזה פועל על MiddleMan — פלטפורמת תיאום תורים ב-WhatsApp ש${businessName} משתמש בה לניהול התורים.`
    : `This booking assistant runs on MiddleMan, a WhatsApp scheduling platform that ${businessName} uses to manage appointments.`
}
