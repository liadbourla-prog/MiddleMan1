export type Lang = 'he' | 'en'

// Detects Hebrew by unicode range — fast, no LLM needed.
export function detectLang(text: string): Lang {
  return /[֐-׿]/.test(text) ? 'he' : 'en'
}

const strings = {
  // ── MiddleMan (provider onboarding) ─────────────────────────────────────────
  mm_welcome: {
    he: `היי! 👋 אני MiddleMan — אגדיר לכם PA ב-WhatsApp תוך כמה דקות בדיוק.\n\nמה שם העסק שלכם?`,
    en: `Hey! 👋 I'm MiddleMan — I'll get your WhatsApp PA running in just a few minutes.\n\nWhat's the name of your business?`,
  },
  mm_ask_timezone: {
    he: `מעולה! באיזו אזור זמן נמצא העסק שלכם?\n\nדוגמאות: "ירושלים", "תל אביב", "ניו יורק" — או שם IANA כמו "Asia/Jerusalem".`,
    en: `Perfect! What timezone is your business in?\n\nExamples: "Tel Aviv", "New York", "London" — or an IANA name like "Asia/Jerusalem".`,
  },
  mm_bad_timezone: {
    he: `לא הצלחתי לזהות את אזור הזמן. נסו שם IANA, למשל:\n"Asia/Jerusalem", "America/New_York", "Europe/London"`,
    en: `I didn't recognise that timezone. Please use an IANA name, for example:\n"Asia/Jerusalem", "America/New_York", "Europe/London"`,
  },
  mm_ask_calendar: {
    he: `כמעט סיימנו! מה ה-Google Calendar ID שלכם?\n\n(Google Calendar → הגדרות → הלוח שלכם → Calendar ID — בדרך כלל נראה כמו כתובת האימייל.)\n\nאמרו "דלג" לטיפול בזה אחר כך.`,
    en: `Almost there! What's your Google Calendar ID?\n\n(Google Calendar → Settings → your calendar → Calendar ID — usually looks like your email.)\n\nSay "skip" to handle it later during full setup.`,
  },
  mm_ask_credentials: {
    he: `דבר אחרון — שלחו את פרטי ה-WhatsApp Business API מ-Meta Business Manager:\n\n• *Phone Number ID* — WhatsApp → Phone Numbers\n• *Access Token* — System User token קבוע\n\nשלחו כך:\n\`ID: 123456789012345\nTOKEN: EAAxxxxxxxxx\``,
    en: `Last thing — share your WhatsApp Business API credentials from Meta Business Manager:\n\n• *Phone Number ID* — WhatsApp → Phone Numbers\n• *Access Token* — your System User permanent token\n\nSend them like this:\n\`ID: 123456789012345\nTOKEN: EAAxxxxxxxxx\``,
  },
  mm_retry_credentials: {
    he: `ננסה שוב — שלחו את הפרטים בפורמט הזה:\n\`ID: 123456789012345\nTOKEN: EAAxxxxxxxxx\``,
    en: `Let's try that again — send your credentials in this format:\n\`ID: 123456789012345\nTOKEN: EAAxxxxxxxxx\``,
  },
  mm_credentials_error: {
    he: (err: string) => `לא הצלחתי לאמת את הפרטים (${err}).\n\nבדקו שה-Phone Number ID וה-Access Token נכונים ב-Meta Business Manager, ונסו שוב.`,
    en: (err: string) => `I couldn't validate those credentials (${err}).\n\nDouble-check your Phone Number ID and Access Token in Meta Business Manager, then try again.`,
  },
  mm_setup_failed: {
    he: (err: string) => `ההגדרה נכשלה: ${err}. נסו שוב או צרו קשר עם התמיכה.`,
    en: (err: string) => `Setup failed: ${err}. Please try again or contact support.`,
  },
  mm_done: {
    he: (phone: string) => `✅ ה-PA שלכם מוכן!\n\nמספר ה-PA: *${phone}*\n\nעכשיו שלחו הודעה למספר הזה מה-WhatsApp האישי שלכם להשלמת ההגדרה (שירותים, שעות, חיבור לוח שנה).\n\nלא תצטרכו את המספר הזה שוב — הכל מנוהל דרך מספר ה-PA.`,
    en: (phone: string) => `✅ Your PA is ready!\n\nPA number: *${phone}*\n\nNow text that number from your personal WhatsApp to complete setup (services, hours, calendar connection).\n\nYou won't need this number again — everything from here is managed through your PA number.`,
  },
  mm_already_done: {
    he: `ה-PA שלכם כבר מוגדר! 🎉 לשינויים, שלחו הודעה למספר ה-PA שלכם ישירות.`,
    en: `Your PA is already set up! 🎉 If you need to make changes, message your PA number directly.`,
  },

  // ── PA manager onboarding (steps.ts / manager-onboarding.ts) ────────────────
  ob_business_name: {
    he: `שלום! אני ה-PA שלכם 👋 בואו נגדיר אותי ביחד — לוקח רק כמה דקות.\n\nאיזה שם יוצג ללקוחות שלכם? (למשל: "מספרת ליאד")`,
    en: `Hi! I'm your new PA 👋 Let's get you set up — only takes a few minutes.\n\nWhat name should I show customers for your business? (e.g. "Liad's Barbershop")`,
  },
  ob_services: {
    he: `נהדר! עכשיו אמרו לי על השירותים שלכם.\n\nשלחו ככה:\n"תספורת 30 דקות, תספורת זקן 20 דקות, גילוח מלא 60 דקות"\n\nלקבוצות הוסיפו קיבולת: "שיעור יוגה 60 דקות (מקס 12)"\nלשירות עם עובד ספציפי: "יוגה עם דניאל 60 דקות"\n\nתוכלו להוסיף ולשנות שירותים בכל עת.`,
    en: `Great! Now tell me your services.\n\nSend them like this:\n"Haircut 30 min, Beard trim 20 min, Full grooming 60 min"\n\nFor group classes add capacity: "Yoga class 60 min (max 12)"\nFor staff-assigned services: "Yoga with Daniel 60 min"\n\nYou can always add or change services later.`,
  },
  ob_services_retry: {
    he: `לא הצלחתי לפענח את זה. רשמו את השירותים עם משך לכל אחד — למשל:\n"תספורת 30 דקות, תספורת זקן 20 דקות"`,
    en: `I didn't quite catch that. Please list your services with a duration for each — for example:\n"Haircut 30 min, Beard trim 20 min"`,
  },
  ob_hours: {
    he: `מעולה! עכשיו קבעו את שעות הפעילות — או אמרו לי שאתם פתוחים 24/7.\n\nדוגמאות:\n• "ראשון-חמישי 9:00-19:00, שישי 9:00-14:00, שבת סגור"\n• "24/7" או "תמיד פתוח"\n\nתוכלו לשנות בכל עת.`,
    en: `Perfect! Now set your working hours — or tell me you're open 24/7.\n\nExamples:\n• "Mon–Fri 9am to 7pm, Saturday 9am to 3pm, closed Sunday"\n• "24/7" or "always open"\n\nYou can change these at any time.`,
  },
  ob_hours_retry: {
    he: `לא הצלחתי לפענח את השעות. נסו שוב — למשל:\n"א'-ה' 9:00–18:00, שישי 9:00–14:00, שבת סגור"\nאו פשוט "24/7" אם אתם תמיד פתוחים.`,
    en: `I couldn't parse those hours. Please try again — for example:\n"Mon–Fri 9:00–18:00, Saturday 9:00–14:00, closed Sunday"\nOr just say "24/7" if you're always open.`,
  },
  ob_247: {
    he: `מובן — אתם פתוחים 24/7 ⏰`,
    en: `Got it — you're open 24/7 ⏰`,
  },
  ob_cancellation: {
    he: `כמה שעות לפני תור לקוחות יכולים לבטל?\n\n• כתבו מספר, למשל "24" או "48"\n• כתבו "0" ללא הגבלה — לקוחות יכולים לבטל בכל עת`,
    en: `How many hours before an appointment can customers cancel?\n\n• Reply a number, e.g. "24" or "48"\n• Reply "0" for no restriction — customers can cancel any time`,
  },
  ob_cancellation_retry: {
    he: `אנא כתבו מספר שעות, למשל "24", "48", או "0" ללא הגבלה.`,
    en: `Please reply with a number of hours, e.g. "24", "48", or "0" for no restriction.`,
  },
  ob_cancellation_confirm_none: {
    he: `ללא הגבלת ביטול — לקוחות יכולים לבטל בכל עת.`,
    en: `No cancellation restriction — customers can cancel any time.`,
  },
  ob_cancellation_confirm: {
    he: (h: number) => `חלון ביטול הוגדר ל-${h} שעות לפני התור.`,
    en: (h: number) => `Cancellation cutoff set to ${h}h before the appointment.`,
  },
  ob_payment: {
    he: `האם לקוחות צריכים לשלם לפני שהתור מאושר?\n\n• "כן" — אבקש מהם לשלם תחילה, ואז אאשר את הסלוט\n• "לא" — התור מאושר מיד כשהם מסכימים`,
    en: `Do customers need to pay before their booking is confirmed?\n\n• "Yes" — I'll ask them to pay first, then lock in the slot\n• "No" — booking is confirmed immediately when they agree`,
  },
  ob_payment_retry: {
    he: `אנא ענו "כן" או "לא" — האם לקוחות צריכים לשלם לפני שאני מאשר את התור?`,
    en: `Please reply "yes" or "no" — should customers pay before I confirm their booking?`,
  },
  ob_payment_immediate: {
    he: `מובן — תורים מאושרים מיד. ✅`,
    en: `Got it — bookings are confirmed immediately. ✅`,
  },
  ob_payment_method_ask: {
    he: `איזו שיטת תשלום אתם משתמשים? (למשל: ביט, PayPal, העברה בנקאית, מזומן בהגעה)`,
    en: `What payment method do you use? (e.g. Bit, PayPal, bank transfer, cash on arrival)`,
  },
  ob_payment_method_confirm: {
    he: (m: string) => `מובן — לקוחות ישלמו דרך ${m} לפני אישור התור. 💳`,
    en: (m: string) => `Got it — customers will pay via ${m} before their booking is confirmed. 💳`,
  },
  ob_escalation: {
    he: `מתי אני צריך לעצור ולהעביר שיחה אליכם ישירות?\n\nדוגמאות: "תלונות", "בקשות החזר כספי", "שאלות תמחור", "לקוחות VIP"\n\nתוכלו גם לומר "רק בקשות לא מובנות" למינימום.\n\nכשאני מעביר, מה לומר ללקוח?\n1. כלום (להודיע לכם בשקט)\n2. "העברתי את זה ל[שם עסק] — ייצרו איתכם קשר"\n3. "הבעלים יחזור אליכם בקרוב"\n4. הודעה מותאמת (אמרו לי מה לכתוב)`,
    en: `When should I stop and hand a conversation to you directly?\n\nExamples: "complaints", "refund requests", "pricing questions", "VIP customers"\n\nYou can also say "only unknown requests" to keep it minimal.\n\nWhen I hand off, what should I tell the customer?\n1. Nothing (notify you silently)\n2. "I've passed this to [your business name] — they'll be in touch"\n3. "The owner will call you back shortly"\n4. Custom message (tell me what to say)`,
  },
  ob_escalation_retry: {
    he: `אנא תארו מתי להעביר שיחות ובחרו 1–4 למה לומר ללקוח.`,
    en: `Please describe when I should hand off conversations to you, and pick 1–4 for what to tell the customer.`,
  },
  ob_escalation_confirm_none: {
    he: `אין כללי העברה ידנית — אעביר רק בקשות שאני ממש לא מצליח להבין.`,
    en: `No manual escalation rules — I'll only forward truly unrecognizable requests.`,
  },
  ob_escalation_confirm: {
    he: (triggers: string) => `מובן — אעביר שיחות כשמופיע: ${triggers}.`,
    en: (triggers: string) => `Got it — I'll hand off conversations when: ${triggers}.`,
  },
  ob_calendar: {
    he: `עכשיו נחבר את Google Calendar שלכם — שם יופיעו כל התורים.\n\nלחצו על הקישור (לוקח כ-20 שניות):\n{{OAUTH_LINK}}\n\nאחרי החיבור, אאשר כאן אוטומטית.\n\nלא משתמשים ב-Google Calendar? ענו "פנימי" ואנהל את לוח הזמנים ישירות.`,
    en: `Now let's connect your Google Calendar — this is where all bookings will appear.\n\nTap the link below (takes about 20 seconds):\n{{OAUTH_LINK}}\n\nOnce connected, I'll confirm here automatically.\n\nDon't use Google Calendar? Reply "internal" and I'll manage your schedule directly.`,
  },
  ob_calendar_internal: {
    he: `מובן — אנהל את לוח הזמנים ישירות (אין צורך ב-Google Calendar). 📋`,
    en: `Got it — I'll manage your schedule directly (no Google Calendar needed). 📋`,
  },
  ob_calendar_waiting: {
    he: (link: string) => `ממתין לחיבור לוח השנה...\n\n${link}`,
    en: (link: string) => `Waiting for calendar connection...\n\n${link}`,
  },
  ob_import: {
    he: `כמעט סיימנו! יש לכם רשימת לקוחות קיימת, היסטוריית תורים או קטלוג שירותים לייבוא?\n\nענו "כן" לקישור העלאה מאובטח, או "דלג" להמשך בלי ייבוא.`,
    en: `Almost done! Do you have an existing customer list, booking history, or service catalog to import?\n\nReply "Yes" to get a secure upload link, or "Skip" to continue without importing.`,
  },
  ob_import_link: {
    he: (url: string) => `הנה קישור ההעלאה המאובטח שלכם (תקף 30 דקות):\n${url}\n\nקבצים מתקבלים:\n• אנשי קשר CSV (שם, טלפון)\n• היסטוריית תורים CSV (שם, טלפון, תאריך, שירות)\n• קטלוג שירותים CSV (שם, משך_דקות, מחיר)\n\nהעלו אחד או יותר, ואז חזרו לכאן.`,
    en: (url: string) => `Here's your secure upload link (valid 30 min):\n${url}\n\nAccepted files:\n• Contacts CSV (name, phone)\n• Booking history CSV (name, phone, date, service)\n• Service catalog CSV (name, duration_minutes, price)\n\nUpload one or more, then come back here.`,
  },
  ob_import_skip: {
    he: `בסדר — תוכלו לייבא נתונים בכל עת בהמשך.`,
    en: `No problem — you can always import data later.`,
  },
  ob_verify: {
    he: `שלחו לי כל הודעה לאישור שה-PA שלכם פועל.`,
    en: `Send me any message to confirm your PA is live and working.`,
  },
  ob_complete: {
    he: (num: string) => `✅ ה-PA שלכם פועל!\n\nלקוחות יכולים עכשיו לשלוח הודעה ל-${num} לתיאום תורים. נהלו הכל על ידי שליחת הודעה אלי ממספר זה.\n\nפקודות שימושיות:\n• STATUS — דוח מצב ה-PA\n• UPCOMING — התורים הקרובים\n• PAUSE / RESUME — השהיה או הפעלה מחדש של ה-PA`,
    en: (num: string) => `✅ Your PA is live!\n\nCustomers can now message ${num} to book appointments. Manage everything by messaging me from this number.\n\nUseful commands:\n• STATUS — PA health report\n• UPCOMING — next scheduled appointments\n• PAUSE / RESUME — suspend or reactivate the PA`,
  },

  // ── Manager ops (apply.ts) ───────────────────────────────────────────────────
  pause_confirm: {
    he: `⏸ ה-PA הושהה. הלקוחות יקבלו הודעה שהעסק מנהל תורים ישירות. שלחו RESUME להפעלה מחדש.`,
    en: `⏸ PA paused. Customers will be told the business is handling appointments directly. Send RESUME to reactivate.`,
  },
  resume_confirm: {
    he: `✅ ה-PA הופעל מחדש. לקוחות יכולים לתאם תורים שוב.`,
    en: `✅ PA reactivated. Customers can book normally again.`,
  },
  escalation_handled: {
    he: (phone: string) => `✅ הפנייה מ-${phone} סומנה כטופלה.`,
    en: (phone: string) => `✅ Escalation from ${phone} marked as handled.`,
  },
  upcoming_none: {
    he: (d?: string) => d ? `אין תורים מאושרים ב-${d}.` : `אין תורים מאושרים קרובים.`,
    en: (d?: string) => d ? `No confirmed bookings on ${d}.` : `No upcoming confirmed bookings.`,
  },
  upcoming_header: {
    he: (label: string, n: number) => `📅 *${label} (${n})*`,
    en: (label: string, n: number) => `📅 *${label} (${n})*`,
  },
  upcoming_label_date: {
    he: (d: string) => `תורים ב-${d}`,
    en: (d: string) => `Bookings on ${d}`,
  },
  upcoming_label_all: {
    he: `התורים הקרובים`,
    en: `Upcoming Bookings`,
  },

  // ── STATUS report labels ─────────────────────────────────────────────────────
  status_live: { he: `✅ ה-PA פעיל`, en: `✅ PA is live` },
  status_paused: { he: `⏸ ה-PA מושהה`, en: `⏸ PA is PAUSED` },
  status_cal_internal: { he: `📋 פנימי (DB)`, en: `📋 Internal (DB)` },
  status_cal_ok: { he: `✅ Google מחובר`, en: `✅ Google Connected` },
  status_cal_missing: { he: `❌ לא מחובר`, en: `❌ Not connected` },
  status_payment_immediate: { he: `⚡ מיידי`, en: `⚡ Immediate` },
  status_payment_post: {
    he: (m: string) => `💳 לאחר תשלום (${m})`,
    en: (m: string) => `💳 Post-payment (${m})`,
  },
  status_customers: { he: `👥 לקוחות`, en: `👥 Customers` },
  status_last_booking: { he: `📋 תור מאושר אחרון`, en: `📋 Last confirmed booking` },
  status_last_msg: { he: `🕐 הודעה אחרונה עובדה`, en: `🕐 Last message processed` },
  status_resume_hint: { he: `שלחו RESUME להפעלה מחדש.`, en: `Send RESUME to reactivate the PA.` },
  status_none: { he: `אין`, en: `None` },
  status_min_ago: {
    he: (m: number) => `לפני ${m} דקות`,
    en: (m: number) => `${m} min ago`,
  },
  status_unknown: { he: `לא ידוע`, en: `Unknown` },

  // ── Customer-facing system messages ─────────────────────────────────────────
  closed_queued: {
    he: (name: string, opens: string) => `${name} סגור כרגע. ${opens ? `אנחנו פותחים ב-${opens}.` : ''} ההודעה שלכם נשמרה ונחזור אליכם כשנפתח.`,
    en: (name: string, opens: string) => `${name} is currently closed.${opens ? ` We open at ${opens}.` : ''} Your message has been saved and we'll reply when we open.`,
  },
  closed_drop: {
    he: (name: string, opens: string) => `${name} סגור כרגע.${opens ? ` אנחנו פותחים ב-${opens}.` : ''} שלחו לנו הודעה ונחזור אליכם.`,
    en: (name: string, opens: string) => `${name} is currently closed.${opens ? ` We open at ${opens}.` : ''} Feel free to message us and we'll get back to you soon.`,
  },
  paused_msg: {
    he: (name: string) => `${name} מנהל תורים ישירות כרגע. צרו קשר איתנו לבדיקת זמינות.`,
    en: (name: string) => `${name} is currently handling appointments directly. Please contact us for availability.`,
  },

  // ── Customer escalation replies (language-aware) ─────────────────────────────
  escalation_customer_passed: {
    he: (biz: string) => `העברתי את זה ל${biz} — ייצרו איתכם קשר בקרוב.`,
    en: (biz: string) => `I've passed your message to ${biz} — they'll be in touch shortly.`,
  },
  escalation_customer_callback: {
    he: (biz: string) => `הצוות של ${biz} יחזור אליכם בקרוב.`,
    en: (biz: string) => `The team at ${biz} will call you back shortly.`,
  },
  escalation_customer_default: {
    he: `ניצור אתכם קשר בקרוב.`,
    en: `We'll get back to you shortly.`,
  },
  escalation_manager_notify: {
    he: (phone: string, msg: string) => `🔔 *פנייה מ-${phone}*\n"${msg}"\n\nענו HANDLED ${phone} לסגירה.`,
    en: (phone: string, msg: string) => `🔔 *Escalation from ${phone}*\n"${msg}"\n\nReply HANDLED ${phone} once resolved.`,
  },

  // ── Manager error / system messages ──────────────────────────────────────────
  manager_classify_error: {
    he: `לא הצלחתי לפענח את ההנחיה. נסו שוב.`,
    en: `I couldn't process that instruction. Please try again.`,
  },
  manager_apply_error: {
    he: (r: string) => `הבנתי אבל לא הצלחתי להחיל: ${r}. נסו לנסח מחדש.`,
    en: (r: string) => `I understood but couldn't apply it: ${r}. Please try rephrasing.`,
  },
  manager_save_error: {
    he: `לא הצלחתי לשמור את ההנחיה. נסו שוב.`,
    en: `I couldn't save that instruction. Please try again.`,
  },
  revoked_access: {
    he: `הגישה שלך בוטלה. פנו לעסק ישירות.`,
    en: `Your access has been revoked. Please contact the business directly.`,
  },

  // ── Verify step ────────────────────────────────────────────────────────────────
  ob_verify_header: {
    he: `הנה סיכום ההגדרות שלכם — בדקו ואשרו:`,
    en: `Here's a summary of your setup — review and confirm:`,
  },
  ob_verify_go_prompt: {
    he: `ענו GO להשקה — או ספרו לי מה לשנות.`,
    en: `Reply GO to launch — or tell me what to change.`,
  },
  ob_verify_correction_done: {
    he: `✅ עודכן. משהו נוסף לשנות? ענו GO כשמוכנים.`,
    en: `✅ Updated. Anything else to change? Reply GO when ready.`,
  },
  ob_verify_services_label: { he: `🛠 שירותים`, en: `🛠 Services` },
  ob_verify_hours_label: { he: `🕐 שעות פעילות`, en: `🕐 Working hours` },
  ob_verify_hours_247: { he: `24/7`, en: `24/7` },
  ob_verify_cancellation_label: { he: `❌ מדיניות ביטול`, en: `❌ Cancellation policy` },
  ob_verify_cancellation_none: { he: `ללא הגבלה`, en: `No restriction` },
  ob_verify_cancellation_hours: {
    he: (h: number) => `${h} שעות לפני התור`,
    en: (h: number) => `${h}h before appointment`,
  },
  ob_verify_payment_label: { he: `💳 תשלום`, en: `💳 Payment` },
  ob_verify_payment_immediate: { he: `מיידי (ללא תשלום מראש)`, en: `Immediate (no upfront payment)` },
  ob_verify_payment_method: {
    he: (m: string) => `לאחר תשלום דרך ${m}`,
    en: (m: string) => `Post-payment via ${m}`,
  },
  ob_verify_escalation_label: { he: `🔔 העברת שיחות`, en: `🔔 Escalation` },
  ob_verify_escalation_none: { he: `רק בקשות לא מובנות`, en: `Only unrecognized requests` },
  ob_verify_calendar_label: { he: `📅 לוח שנה`, en: `📅 Calendar` },
  ob_verify_calendar_google: { he: `Google Calendar מחובר`, en: `Google Calendar connected` },
  ob_verify_calendar_internal: { he: `פנימי (ללא Google)`, en: `Internal (no Google)` },
  ob_calendar_connected: {
    he: `✅ Google Calendar מחובר!`,
    en: `✅ Google Calendar connected!`,
  },

  // ── Import completion ─────────────────────────────────────────────────────────
  ob_import_complete_msg: {
    he: (imported: string, errorNote: string) => `✅ הייבוא הושלם! יובא: ${imported}.${errorNote}`,
    en: (imported: string, errorNote: string) => `✅ Import complete! Imported: ${imported}.${errorNote}`,
  },
  ob_import_contacts: { he: (n: number) => `${n} אנשי קשר`, en: (n: number) => `${n} contacts` },
  ob_import_services_count: { he: (n: number) => `${n} שירותים`, en: (n: number) => `${n} services` },
  ob_import_history: { he: (n: number) => `${n} תורים`, en: (n: number) => `${n} past bookings` },
  ob_import_skipped: {
    he: (n: number) => `\n⚠️ ${n} שורות דולגו.`,
    en: (n: number) => `\n⚠️ ${n} row(s) skipped.`,
  },
  ob_import_nothing: { he: `לא יובא דבר`, en: `nothing` },

  // ── Apply.ts confirmations (bilingual) ────────────────────────────────────────
  apply_blocked: {
    he: (label: string) => `הבנתי — ${label} חסום.`,
    en: (label: string) => `Got it — ${label} is blocked.`,
  },
  apply_unblocked: {
    he: (label: string) => `הבנתי — ${label} פתוח שוב.`,
    en: (label: string) => `Got it — ${label} is open again.`,
  },
  apply_hours_set: {
    he: (label: string, open: string, close: string) => `שעות עודכנו עבור ${label}: ${open}–${close}.`,
    en: (label: string, open: string, close: string) => `Hours set for ${label}: ${open}–${close}.`,
  },
  apply_bulk_close: {
    he: (start: string, end: string) => `סגור מ-${start} עד ${end}.`,
    en: (start: string, end: string) => `Closed from ${start} to ${end}.`,
  },
  apply_service_created: {
    he: (name: string, dur: number, extra: string) => `שירות "${name}" נוצר (${dur} דקות${extra}).`,
    en: (name: string, dur: number, extra: string) => `Service "${name}" created (${dur} min${extra}).`,
  },
  apply_service_deactivated: {
    he: (name: string) => `שירות "${name}" הושבת.`,
    en: (name: string) => `Service "${name}" deactivated.`,
  },
  apply_service_updated: {
    he: (name: string) => `שירות "${name}" עודכן.`,
    en: (name: string) => `Service "${name}" updated.`,
  },
  apply_service_not_found: {
    he: (name: string) => `שירות "${name}" לא נמצא.`,
    en: (name: string) => `Service "${name}" not found.`,
  },
  apply_service_blocked: {
    he: (name: string, count: number, date: string) =>
      `לא ניתן להשבית "${name}" — יש ${count} הזמנות עתידיות (מוקדמת: ${date}). בטלו אותן קודם.`,
    en: (name: string, count: number, date: string) =>
      `Cannot deactivate "${name}" — ${count} future booking(s) still active (earliest: ${date}). Cancel them first.`,
  },
  apply_permission_granted: {
    he: (who: string) => `${who} קיבל גישה כמשתמש מורשה.`,
    en: (who: string) => `${who} granted delegated access.`,
  },
  apply_permission_revoked: {
    he: (who: string) => `גישה בוטלה עבור ${who}.`,
    en: (who: string) => `Access revoked for ${who}.`,
  },
  apply_permission_not_found: {
    he: (phone: string) => `לא נמצאה זהות עבור ${phone}.`,
    en: (phone: string) => `No identity found for ${phone}.`,
  },
  apply_policy_noted: {
    he: `הנחיית מדיניות נשמרה.`,
    en: `Policy instruction noted and saved.`,
  },
  apply_unknown_type: {
    he: (type: string) => `סוג הנחיה לא מוכר: ${type}.`,
    en: (type: string) => `Unknown instruction type: ${type}.`,
  },
  apply_hours_conflict: {
    he: (count: number, date: string) =>
      `לא ניתן לשנות שעות — ${count} הזמנות קיימות מחוץ לשעות החדשות ב-${date}. בטלו אותן קודם.`,
    en: (count: number, date: string) =>
      `Cannot set hours — ${count} confirmed booking(s) fall outside the new hours on ${date}. Cancel them first.`,
  },
  apply_set_hours_requires_times: {
    he: `set_hours דורש openTime ו-closeTime.`,
    en: `set_hours requires openTime and closeTime.`,
  },
  apply_set_hours_requires_target: {
    he: `set_hours דורש dayOfWeek או specificDate.`,
    en: `set_hours requires either dayOfWeek or specificDate.`,
  },

  // ── Booking cancellation (schedule change) ──────────────────────────────────
  booking_cancelled_schedule: {
    he: (date: string) =>
      `מצטערים — התור שלכם ב-${date} בוטל בשל שינוי בלוח הזמנים.\n\nענו REBOOK למציאת מועד חדש, או צרו קשר ישירות לתיאום מחדש.`,
    en: (date: string) =>
      `We're sorry — your appointment on ${date} has been cancelled due to a schedule change.\n\nReply REBOOK to find a new slot, or contact us directly to reschedule.`,
  },

  // ── Reminders ────────────────────────────────────────────────────────────────
  reminder_24h: {
    he: (service: string, biz: string, date: string, time: string) =>
      `תזכורת: ${service} ב-${biz} מחר, ${date} בשעה ${time}. ענו CANCEL אם ברצונכם לבטל.`,
    en: (service: string, biz: string, date: string, time: string) =>
      `Reminder: ${service} at ${biz} is tomorrow, ${date} at ${time}. Reply CANCEL if you need to cancel.`,
  },
  reminder_1h: {
    he: (service: string, biz: string, time: string) =>
      `תזכורת: ${service} ב-${biz} בעוד שעה בשעה ${time}. להתראות!`,
    en: (service: string, biz: string, time: string) =>
      `Reminder: ${service} at ${biz} is in 1 hour at ${time}. See you soon!`,
  },

  // ── Waitlist offer ────────────────────────────────────────────────────────────
  waitlist_offer: {
    he: (biz: string, service: string, date: string, ttl: number) =>
      `בשורות טובות! נפתח מקום ב-${biz}: ${service} ב-${date}. ענו כן לתפיסת המקום או לא לוויתור. ההצעה פגה בעוד ${ttl} דקות.`,
    en: (biz: string, service: string, date: string, ttl: number) =>
      `Great news! A slot opened up at ${biz}: ${service} on ${date}. Reply YES to book it or NO to pass. This offer expires in ${ttl} minutes.`,
  },

  // ── Payment confirmation to customer ────────────────────────────────────────
  payment_confirmed: {
    he: (service: string, biz: string, date: string, time: string) =>
      `✅ ה${service} שלכם ב-${biz} אושר ל-${date} בשעה ${time}. להתראות!`,
    en: (service: string, biz: string, date: string, time: string) =>
      `✅ Your ${service} at ${biz} is confirmed for ${date} at ${time}. See you then!`,
  },
} as const

// Type-safe accessor — falls back to 'en' if a key is missing for 'he'
export function t(key: keyof typeof strings, lang: Lang): string {
  const entry = strings[key]
  const val = (entry as Record<Lang, unknown>)[lang] ?? (entry as Record<Lang, unknown>)['en']
  if (typeof val === 'string') return val
  // Function strings are accessed directly; this overload handles simple strings only
  return String(val)
}

// For strings that require interpolation — call the function directly from the strings object
export const i18n = strings
