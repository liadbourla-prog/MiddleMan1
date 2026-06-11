export type Lang = 'he' | 'en'

// Detects Hebrew by unicode range — fast, no LLM needed.
export function detectLang(text: string): Lang {
  return /[֐-׿]/.test(text) ? 'he' : 'en'
}

// The single inline language-switch offer suffix (CHAT_LEVEL_LAWBOOK §3.4),
// appended to a Branch 3 reply when the message arrived in a language other than
// the configured default. Worded in the DETECTED language, never bilingual.
// Returned with a leading blank line so it reads as a separate trailing line.
export function managerSwitchOfferSuffix(detected: Lang): string {
  return detected === 'en'
    ? '\n\n(Want me to switch to English? Reply YES)'
    : '\n\n(רוצה שאמשיך בעברית? כתוב/י כן)'
}

const strings = {
  // ── MiddleMan (provider onboarding) ─────────────────────────────────────────
  mm_welcome: {
    he: `היי! 👋 נגדיר לך עוזר אישי ב-WhatsApp תוך כמה דקות.\n\nאיך קוראים לעסק?`,
    en: `Hey! 👋 Let's get your WhatsApp assistant up and running — takes just a few minutes.\n\nWhat's your business called?`,
  },
  mm_ask_timezone: {
    he: `מעולה! באיזו אזור זמן נמצא העסק שלכם?\n\nדוגמאות: "ירושלים", "תל אביב", "ניו יורק" — או שם IANA כמו "Asia/Jerusalem".`,
    en: `Perfect! What timezone is your business in?\n\nExamples: "Tel Aviv", "New York", "London" — or an IANA name like "Asia/Jerusalem".`,
  },
  mm_bad_timezone: {
    he: `רגע, לא תפסתי את אזור הזמן. אפשר לכתוב שם עיר או אזור IANA — למשל:\n"Asia/Jerusalem", "America/New_York", "Europe/London"`,
    en: `Hmm, that timezone didn't land. Try a city or an IANA name — for example:\n"Asia/Jerusalem", "America/New_York", "Europe/London"`,
  },
  mm_ask_calendar_mode: {
    he: `האם יש לכם Google Calendar שתרצו לחבר, או שנתחיל עם יומן פנימי בינתיים? (אפשר לחבר Google בכל עת מאוחר יותר)`,
    en: `Do you have a Google Calendar you'd like to connect, or should I manage scheduling internally for now? (You can always connect Google Calendar later)`,
  },
  mm_ask_calendar: {
    he: `מה ה-Google Calendar ID שלכם?\n\n(Google Calendar → הגדרות → הלוח שלכם → Calendar ID — בדרך כלל נראה כמו כתובת האימייל.)`,
    en: `What's your Google Calendar ID?\n\n(Google Calendar → Settings → your calendar → Calendar ID — usually looks like your email.)`,
  },
  mm_ask_services: {
    he: `מה השירות הראשי שלכם ואיך הוא נקרא? ספרו גם כמה זמן לוקח — למשל "תספורת, 30 דקות". אפשר לרשום כמה שירותים ביחד.`,
    en: `What's your main service and what do you call it? Include how long it takes — like "Haircut, 30 minutes". You can list multiple services together.`,
  },
  mm_bad_services: {
    he: `רגע, לא תפסתי. נסו שוב — למשל: *תספורת, 30 דקות*`,
    en: `Didn't quite catch that — try again, like: *Haircut, 30 minutes*`,
  },
  mm_embedded_signup_link: {
    he: (url: string) => `כמעט סיימנו! לחצו על הקישור כדי לחבר את מספר ה-WhatsApp שלכם — לוקח כ-30 שניות:\n${url}`,
    en: (url: string) => `Almost done! Tap this link to connect your WhatsApp number — takes about 30 seconds:\n${url}`,
  },
  mm_embedded_signup_waiting: {
    he: `כשתסיימו עם הקישור, אקבל אישור אוטומטי ואסיים את ההגדרה.`,
    en: `Once you complete the link, I'll get a confirmation automatically and finish setup.`,
  },
  mm_embedded_signup_error: {
    he: (err: string) => `החיבור לא תפס הפעם (${err}). ננסה שוב? אם זה חוזר, אני כאן לעזור.`,
    en: (err: string) => `The connection didn't go through this time (${err}). Want to try again? If it keeps happening, I'm here to help.`,
  },
  mm_no_number_linked: {
    he: `לא חובר מספר WhatsApp. מטא החזירה התחברות אך ללא מספר — סימן שכבר יש חיבור קודם לחשבון.\n\nכדי לתקן: היכנסו לפייסבוק → הגדרות → אינטגרציות עסקיות (Business Integrations) → MiddleMan → הסירו. ואז נסו שוב את הקישור — הפעם יופיע שלב סריקת ה-QR לחיבור המספר.`,
    en: `No WhatsApp number was linked. Meta returned a login but no number — which means this account already has a prior connection.\n\nTo fix: open Facebook → Settings → Business Integrations → MiddleMan → Remove. Then tap the link again — this time the QR / number step will appear.`,
  },
  mm_setup_failed: {
    he: (err: string) => `ההגדרה נכשלה: ${err}. נסו שוב או צרו קשר עם התמיכה.`,
    en: (err: string) => `Setup failed: ${err}. Please try again or contact support.`,
  },
  mm_done: {
    he: (phone: string) => `✅ ה-PA שלכם מוכן!\n\nמספר ה-PA: *${phone}*\n\nשלחו הודעה למספר הזה מה-WhatsApp האישי שלכם — ה-PA ידריך אתכם משם.`,
    en: (phone: string) => `✅ Your PA is ready!\n\nPA number: *${phone}*\n\nText that number from your personal WhatsApp — your PA will guide you from there.`,
  },
  mm_already_done: {
    he: `ה-PA שלכם כבר מוגדר! 🎉 לשינויים, שלחו הודעה למספר ה-PA שלכם ישירות.`,
    en: `Your PA is already set up! 🎉 If you need to make changes, message your PA number directly.`,
  },

  // ── WABA detection (new steps) ───────────────────────────────────────────────
  mm_waba_check: {
    he: `האם יש לכם כבר מספר וואטסאפ עסקי?`,
    en: `Do you already have a WhatsApp Business number for your business?`,
  },
  mm_waba_guide_type: {
    he: `האם המספר הזה פועל דרך אפליקציית וואטסאפ ביזנס בטלפון, או שהוא מחובר דרך Meta Business Manager?`,
    en: `Is that number running through the WhatsApp Business App on your phone, or is it connected through Meta Business Manager?`,
  },
  mm_waba_guide_bsp: {
    he: `האם הגדרתם את החשבון בעצמכם, או שחברה חיצונית ניהלה את ההגדרה עבורכם?`,
    en: `Did you set up the account yourselves, or did an external company manage the setup for you?`,
  },

  // Case 2 — coexistence (existing WhatsApp Business App number)
  mm_coexistence_link: {
    he: (url: string) => `מעולה — המספר שלכם יישאר פעיל בוואטסאפ ביזנס ויתחבר גם ל-PA. תצטרכו חשבון פייסבוק אישי. לחצו:\n\n${url}\n\nחשוב: כדי לשמור על החיבור, פתחו את אפליקציית וואטסאפ ביזנס לפחות פעם בשבועיים.`,
    en: (url: string) => `Great — your number will stay active in the WhatsApp Business App and connect to the PA as well. You'll need a personal Facebook account. Tap:\n\n${url}\n\nImportant: to keep the connection active, open the WhatsApp Business App at least once every two weeks.`,
  },
  // Case 1 — post-provisioning coexistence nudge (sent after provisioning, not in the flow)
  mm_case1_coexistence_nudge: {
    he: `טיפ לשבוע הבא: אחרי 7 ימים של שימוש במספר החדש, תוכלו לחבר אותו לאפליקציית וואטסאפ ביזנס ולראות את כל השיחות ישירות שם. כשתהיו מוכנים — שלחו לי "חיבור" בצ'אט הזה.`,
    en: `Tip for next week: after 7 days of activity on your new number, you can connect it to the WhatsApp Business App and see all conversations directly there. When you're ready — reply "connect" in this chat.`,
  },

  // Case 1 — fresh number
  mm_case1_link: {
    he: (url: string) => `מעולה. שימו לב — תצטרכו חשבון פייסבוק אישי כדי להתחבר. אם אין לכם, פתחו אחד ב-facebook.com לפני שתלחצו.\n\n${url}`,
    en: (url: string) => `Great. Note — you'll need a personal Facebook account to connect. If you don't have one, create one at facebook.com first.\n\n${url}`,
  },

  // Case 3a — existing Cloud API WABA
  mm_case3a_link: {
    he: (url: string) => `מצוין. היכנסו עם חשבון הפייסבוק המקושר ל-Meta Business Manager שלכם.\n\n${url}`,
    en: (url: string) => `Great. Log in with the Facebook account linked to your Meta Business Manager.\n\n${url}`,
  },

  // Case 3b — BSP managed, out of scope
  mm_case3b_exit: {
    he: `במקרה הזה צריך לתאם את החיבור ישירות עם החברה שהגדירה את החשבון. בקשו מהם לחבר את המספר ל-PA, ואז חזרו אלינו.`,
    en: `In this case the connection needs to be coordinated with the company that set up the account. Ask them to connect the number to the PA, then come back to us.`,
  },

  // Business Suite post-provisioning
  mm_business_suite: {
    he: `עוד דבר — כדי לצפות בשיחות ולהשתלט עליהן ידנית אם צריך, הורידו את *Meta Business Suite* לטלפון או היכנסו ל-business.facebook.com. שם תראו את כל השיחות עם הלקוחות בזמן אמת.`,
    en: `One more thing — to view conversations and step in manually when needed, download *Meta Business Suite* or go to business.facebook.com. You'll see all customer conversations there in real time.`,
  },

  // ── PA manager onboarding (steps.ts / manager-onboarding.ts) ────────────────
  ob_business_name: {
    he: `שלום! אני ה-PA שלכם 👋 בואו נגדיר אותי ביחד — לוקח רק כמה דקות.\n\nאיזה שם יוצג ללקוחות שלכם? (למשל: "מספרת ליאד")`,
    en: `Hi! I'm your new PA 👋 Let's get you set up — only takes a few minutes.\n\nWhat name should I show customers for your business? (e.g. "Liad's Barbershop")`,
  },
  ob_services: {
    he: `מה השירותים שאתם מציעים? שלחו שם ומשך לכל שירות — למשל "תספורת 30 דקות, תספורת זקן 20 דקות". לשיעור קבוצתי הוסיפו "(מקס 12)". אפשר לשנות בכל עת.`,
    en: `What services do you offer? Send the name and duration for each — like "Haircut 30 min, Beard trim 20 min". For group classes add "(max 12)". You can always change these later.`,
  },
  ob_services_retry: {
    he: `רגע, לא תפסתי. רשמו לי כל שירות עם משך — למשל:\n"תספורת 30 דקות, תספורת זקן 20 דקות"`,
    en: `Didn't quite catch that — list each service with a duration, like:\n"Haircut 30 min, Beard trim 20 min"`,
  },
  ob_hours: {
    he: `מתי אתם פתוחים? שלחו ימים ושעות — למשל "ראשון-חמישי 9:00-19:00, שישי 9:00-14:00". אם תמיד פתוחים, פשוט אמרו "24/7".`,
    en: `When are you open? Send your days and hours — like "Mon–Fri 9am–7pm, Saturday 9am–2pm, closed Sunday". If you're always open, just say "24/7".`,
  },
  ob_hours_retry: {
    he: `רגע, לא תפסתי את השעות. נסו שוב — למשל:\n"א'-ה' 9:00–18:00, שישי 9:00–14:00, שבת סגור"\nאו פשוט "24/7" אם אתם תמיד פתוחים.`,
    en: `Didn't quite catch those hours — try again, like:\n"Mon–Fri 9:00–18:00, Saturday 9:00–14:00, closed Sunday"\nOr just say "24/7" if you're always open.`,
  },
  ob_247: {
    he: `מובן — אתם פתוחים 24/7 ⏰`,
    en: `Got it — you're open 24/7 ⏰`,
  },
  ob_cancellation: {
    he: `עד כמה שעות מראש לקוחות יכולים לבטל תור? כתבו מספר — למשל "24". אם אין הגבלה ולקוחות יכולים לבטל בכל עת, כתבו "0".`,
    en: `Up to how many hours in advance can customers cancel an appointment? Write a number — like "24". If there's no restriction and customers can cancel any time, write "0".`,
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
    he: `האם לקוחות צריכים לשלם לפני שאאשר את התור? אם כן — באיזו שיטה הם משלמים? (למשל: ביט, PayPal, העברה בנקאית)`,
    en: `Do customers need to pay before I confirm their booking? If yes — what's the payment method? (e.g. Bit, PayPal, bank transfer)`,
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
    he: `מתי אני צריך לעצור ולהעביר שיחה אליכם ישירות — אילו נושאים או מצבים? ומה לומר ללקוח ברגע כזה — שיצרו איתו קשר, שתתקשרו חזרה, או לא לומר כלום?`,
    en: `When should I stop and hand a conversation to you directly — what topics or situations? And what should I tell the customer at that point — that someone will be in touch, that you'll call back, or nothing at all?`,
  },
  ob_escalation_retry: {
    he: `ספרו לי מתי להעביר שיחות אליכם, ומה לומר ללקוח כשאני מעביר.`,
    en: `Tell me when I should hand off conversations to you, and what to say to the customer when I do.`,
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
    he: `כמעט סיימנו! יש לכם רשימת לקוחות, היסטוריית תורים או קטלוג שירותים לייבוא? ענו "כן" לקישור העלאה, או "דלג" להמשך.`,
    en: `Almost done! Do you have an existing customer list, booking history, or service catalog to import? Reply "Yes" for an upload link, or "Skip" to continue.`,
  },
  ob_import_link: {
    he: (url: string) => `הנה קישור ההעלאה המאובטח שלכם (תקף 30 דקות):\n${url}\n\nמקבלים CSV של אנשי קשר (שם, טלפון), היסטוריית תורים (שם, טלפון, תאריך, שירות), או קטלוג שירותים (שם, משך_דקות, מחיר). העלו אחד או יותר ואז חזרו לכאן.`,
    en: (url: string) => `Here's your secure upload link (valid 30 min):\n${url}\n\nAccepted: CSV of contacts (name, phone), booking history (name, phone, date, service), or service catalog (name, duration_minutes, price). Upload one or more, then come back here.`,
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
    he: `רגע, לא תפסתי מה לעשות. אפשר לנסח קצת אחרת?`,
    en: `Hmm, didn't quite catch that — mind putting it another way?`,
  },
  manager_apply_error: {
    he: (r: string) => `הבנתי מה ביקשת, אבל זה לא עבר: ${r}. ננסה שוב?`,
    en: (r: string) => `Got what you meant, but it didn't go through: ${r}. Want to try again?`,
  },
  manager_save_error: {
    he: `זה לא נשמר לי כרגע. ננסה שוב?`,
    en: `That didn't save just now — want to try again?`,
  },
  manager_unknown_instruction: {
    he: `לא בטוח מה לשנות פה. אני יכול לעזור עם שעות פתיחה, מדיניות ביטול, הוספה או הסרה של שירותים, הרשאות, וגם שאלות כלליות — מה בא לך?`,
    en: `Not sure what to change there. I can help with hours, cancellation policy, adding or removing services, permissions, or general questions — what are you after?`,
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
    he: (label: string, open: string, close: string) => `עדכנתי את השעות ל${label}: ${open}–${close}.`,
    en: (label: string, open: string, close: string) => `Updated ${label} to ${open}–${close}.`,
  },
  apply_bulk_close: {
    he: (start: string, end: string) => `סגרתי מ-${start} עד ${end}.`,
    en: (start: string, end: string) => `Closed you off from ${start} to ${end}.`,
  },
  apply_service_created: {
    he: (name: string, dur: number, extra: string) => `הוספתי את "${name}" (${dur} דקות${extra}).`,
    en: (name: string, dur: number, extra: string) => `Added "${name}" (${dur} min${extra}).`,
  },
  apply_service_deactivated: {
    he: (name: string) => `כיביתי את "${name}".`,
    en: (name: string) => `Turned off "${name}".`,
  },
  apply_service_updated: {
    he: (name: string) => `עדכנתי את "${name}".`,
    en: (name: string) => `Updated "${name}".`,
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
    he: (who: string) => `נתתי ל${who} גישה כמשתמש מורשה.`,
    en: (who: string) => `Gave ${who} delegated access.`,
  },
  apply_permission_revoked: {
    he: (who: string) => `ביטלתי את הגישה של ${who}.`,
    en: (who: string) => `Revoked ${who}'s access.`,
  },
  apply_permission_not_found: {
    he: (phone: string) => `לא נמצאה זהות עבור ${phone}.`,
    en: (phone: string) => `No identity found for ${phone}.`,
  },
  apply_policy_noted: {
    he: `הנחיית מדיניות נשמרה.`,
    en: `Policy instruction noted and saved.`,
  },
  apply_policy_cancellation_cutoff: {
    he: (hours: number) => `עדכנתי — לקוחות יכולים לבטל עד ${hours} שעות לפני התור.`,
    en: (hours: number) => `Done — customers can now cancel up to ${hours} hours before the appointment.`,
  },
  apply_policy_booking_buffer: {
    he: (hours: number) => `עדכנתי — צריך להזמין לפחות ${hours} שעות מראש.`,
    en: (hours: number) => `Done — bookings now need at least ${hours} hours' notice.`,
  },
  apply_policy_max_days: {
    he: (days: number) => `עדכנתי — אפשר להזמין עד ${days} ימים קדימה.`,
    en: (days: number) => `Done — customers can now book up to ${days} days ahead.`,
  },
  apply_policy_cancellation_fee: {
    he: (amount: number, currency: string) => `עדכנתי את עמלת הביטול ל-${amount} ${currency}.`,
    en: (amount: number, currency: string) => `Set the cancellation fee to ${amount} ${currency}.`,
  },
  apply_policy_unsupported: {
    he: `הנחיה זו אינה ניתנת לביצוע אוטומטי. ניתן לעדכן: זמן ביטול, זמן הזמנה מינימלי, טווח הזמנות, עמלת ביטול.`,
    en: `This policy cannot be applied automatically. Supported: cancellation cutoff, minimum booking buffer, booking window (days ahead), cancellation fee.`,
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
      `סליחה על ההפתעה — נאלצנו לבטל את התור שלכם ב-${date} בגלל שינוי בלו״ז. רוצים שאמצא לכם מועד אחר? רק תגידו לי מתי נוח ונסדר.`,
    en: (date: string) =>
      `Sorry for the surprise — we had to cancel your ${date} appointment because of a schedule change. Want me to find you another time? Just tell me when works and I'll sort it.`,
  },

  // ── Reminders ────────────────────────────────────────────────────────────────
  reminder_24h: {
    he: (service: string, biz: string, date: string, time: string) =>
      `תזכורת קטנה — ${service} ב${biz} מחר (${date}) ב-${time}. אם משהו השתנה, רק תכתבו לי ונסדר. נתראה!`,
    en: (service: string, biz: string, date: string, time: string) =>
      `Quick reminder — ${service} at ${biz} tomorrow (${date}) at ${time}. If anything's changed, just let me know and we'll sort it. See you!`,
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
      `התפנה מקום! ${service} ב${biz} ב-${date}. רוצים אותו? רק תגידו לי ואני תופס לכם — שמרתי אותו ל-${ttl} הדקות הקרובות.`,
    en: (biz: string, service: string, date: string, ttl: number) =>
      `A spot just opened — ${service} at ${biz} on ${date}. Want it? Just say the word and it's yours — I'm holding it for the next ${ttl} minutes.`,
  },

  // ── Payment confirmation to customer ────────────────────────────────────────
  payment_confirmed: {
    he: (service: string, biz: string, date: string, time: string) =>
      `✅ ה${service} שלכם ב-${biz} אושר ל-${date} בשעה ${time}. להתראות!`,
    en: (service: string, biz: string, date: string, time: string) =>
      `✅ Your ${service} at ${biz} is confirmed for ${date} at ${time}. See you then!`,
  },

  // ── Operator console ─────────────────────────────────────────────────────────
  op_help: {
    he: `הנה מה שאני יכול לעשות לך מכאן:\n\n• \`סטטוס הכל\` — מצב כל העסקים הפעילים\n• \`סטטוס [שם]\` — דוח מפורט לעסק אחד\n• \`מיומנויות [שם]\` — מצב זרימות המיומנויות לעסק\n• \`פניות\` — 10 פניות פתוחות אחרונות\n• \`פיצ'רים\` — בקשות פיצ'רים נדחות\n• \`הפעל מחדש [שם]\` — רשימת סקילים שניתן להפעיל מחדש\n• \`הפעל מחדש [שם] [סקיל]\` — הפעלת סקיל ספציפי מחדש\n• \`עדכן הכל: [הנחיה]\` — דחוף שינוי לכל הסוכנים\n\nפשוט תכתוב מה שאתה צריך.`,
    en: `Here's what I can pull up for you:\n\n• \`STATUS ALL\` — health of all live businesses\n• \`STATUS [name]\` — detailed report for one business\n• \`SKILLS [name]\` — skill workflow state for one business\n• \`ESCALATIONS\` — last 10 unresolved customer escalations\n• \`FEATURES\` — deferred feature requests queue\n• \`RETRIGGER [name]\` — list retriggerable skills for a business\n• \`RETRIGGER [name] [skill]\` — re-create a specific skill workflow\n• \`UPDATE ALL: [instruction]\` — push a change to every live agent\n\nJust tell me what you need.`,
  },
  op_status_no_businesses: {
    he: `לא נרשמו עסקים עדיין.`,
    en: `No businesses registered yet.`,
  },
  op_status_header: {
    he: (n: number) => `📊 *כל העסקים (${n})*`,
    en: (n: number) => `📊 *All Businesses (${n})*`,
  },
  op_status_onboarding: { he: `⏳ בהגדרה`, en: `⏳ onboarding` },
  op_status_paused: { he: `⏸ מושהה`, en: `⏸ paused` },
  op_status_live: { he: `✅ פעיל`, en: `✅ live` },
  op_status_not_found: {
    he: (q: string) => `לא נמצא עסק התואם "${q}".`,
    en: (q: string) => `No business found matching "${q}".`,
  },
  op_escalations_none: {
    he: `✅ אין פניות פתוחות.`,
    en: `✅ No open escalations.`,
  },
  op_escalations_header: {
    he: (n: number) => `⚠️ *פניות פתוחות (${n})*`,
    en: (n: number) => `⚠️ *Open Escalations (${n})*`,
  },
  op_update_none: {
    he: `אין עסקים פעילים לעדכון.`,
    en: `No live businesses to update.`,
  },
  op_update_ok: {
    he: (applied: number, total: number) => `✅ העדכון הוחל על ${applied}/${total} עסקים.`,
    en: (applied: number, total: number) => `✅ Update applied to ${applied}/${total} businesses.`,
  },
  op_update_clarify: {
    he: (msg: string) => `נדרשת הבהרה לפני הפצה לכל הסוכנים: ${msg}`,
    en: (msg: string) => `Clarification needed before applying to all agents: ${msg}`,
  },
  op_update_classify_fail: {
    he: `רגע, לא תפסתי מה לעדכן. אפשר לנסח קצת אחרת?`,
    en: `Hmm, I didn't catch what to update there — mind rephrasing?`,
  },

  // ── Operator — knowledge setup status ────────────────────────────────────────
  op_knowledge_label: { he: `הגדרת ידע`, en: `Knowledge setup` },
  op_knowledge_none: { he: `⚠️ לא החל`, en: `⚠️ Not started` },
  op_knowledge_active: { he: `🔄 בתהליך`, en: `🔄 In progress` },
  op_knowledge_completed: { he: `✅ הושלם`, en: `✅ Completed` },
  op_knowledge_failed: { he: `❌ נכשל`, en: `❌ Failed` },

  // ── Operator — SKILLS command ─────────────────────────────────────────────────
  op_skills_header: {
    he: (name: string) => `🧠 *מיומנויות — ${name}*`,
    en: (name: string) => `🧠 *Skills — ${name}*`,
  },
  op_skills_none: {
    he: `לא נמצאו זרימות עבודה.`,
    en: `No skill workflows found.`,
  },
  op_skills_faqs: {
    he: (n: number) => `שאלות נפוצות פעילות: ${n}`,
    en: (n: number) => `Active FAQs: ${n}`,
  },
  op_skills_deferred: {
    he: (n: number) => `בקשות פיצ'רים נדחות: ${n}`,
    en: (n: number) => `Deferred feature requests: ${n}`,
  },

  // ── Operator — FEATURES command ───────────────────────────────────────────────
  op_features_none: {
    he: `✅ אין בקשות פיצ'רים נדחות.`,
    en: `✅ No deferred feature requests.`,
  },
  op_features_header: {
    he: (n: number) => `💡 *בקשות פיצ'רים נדחות (${n})*`,
    en: (n: number) => `💡 *Deferred Feature Requests (${n})*`,
  },

  // ── Operator — RETRIGGER command ──────────────────────────────────────────────
  op_retrigger_not_live: {
    he: (name: string) => `"${name}" עדיין בהגדרה — לא ניתן להפעיל מחדש.`,
    en: (name: string) => `"${name}" hasn't completed onboarding — cannot retrigger.`,
  },
  op_retrigger_already_active: {
    he: (name: string, skill: string) => `זרימת "${skill}" עבור ${name} כבר פעילה.`,
    en: (name: string, skill: string) => `"${skill}" workflow for ${name} is already active.`,
  },
  op_retrigger_no_manager: {
    he: (name: string) => `לא נמצא מנהל פעיל עבור ${name}.`,
    en: (name: string) => `No active manager found for ${name}.`,
  },
  op_retrigger_ok: {
    he: (name: string, skill: string) => `✅ זרימת "${skill}" הופעלה מחדש עבור ${name}.`,
    en: (name: string, skill: string) => `✅ "${skill}" workflow re-created for ${name}.`,
  },
  op_retrigger_skill_unknown: {
    he: (skill: string) => `"${skill}" אינו סקיל שניתן להפעיל מחדש. בדקו את רשימת הסקילים בפקודה \`הפעל מחדש [עסק]\`.`,
    en: (skill: string) => `"${skill}" is not a retriggerable skill. Check available skills with \`RETRIGGER [business]\`.`,
  },
  op_retrigger_list: {
    he: (name: string, list: string) => `סקילים שניתן להפעיל מחדש עבור ${name}:\n\n${list}\n\nשלחו \`הפעל מחדש ${name} [שם-סקיל]\`.`,
    en: (name: string, list: string) => `Retriggerable skills for ${name}:\n\n${list}\n\nSend \`RETRIGGER ${name} [skill-name]\`.`,
  },

  // ── System / adapter messages ─────────────────────────────────────────────────
  // Bilingual single-line — used when no language context is available (non-text messages)
  non_text_reply: {
    he: `אני מבין רק הודעות טקסט. / I can only understand text messages.`,
    en: `אני מבין רק הודעות טקסט. / I can only understand text messages.`,
  },
  manager_process_error: {
    he: (phone: string, err: string) => `⚠️ הודעה מ-${phone} לא עובדה.\nשגיאה: ${err}\n\nאנא פנו ללקוח ישירות.`,
    en: (phone: string, err: string) => `⚠️ A message from ${phone} could not be processed.\nError: ${err}\n\nPlease follow up with the customer directly.`,
  },
  calendar_auth_expired: {
    he: `חיבור Google Calendar פג תוקף ולא ניתן לחדשו אוטומטית. אנא חיברו מחדש את לוח השנה.`,
    en: `Your Google Calendar connection has expired and could not be refreshed automatically. Please reconnect your calendar.`,
  },
  calendar_mirror_divergence: {
    he: `⚠️ אירוע אחד לא נכנס ל-Google Calendar שלך אחרי כמה ניסיונות. אצלי הלו״ז מעודכן ונכון — רק תצוגת Google אולי לא מסונכרנת כרגע. אני ממשיך לנסות ברקע, ואם זה נמשך — חיבור מחדש של היומן יסדר את זה.`,
    en: `⚠️ One event didn't make it into your Google Calendar after a few tries. Your actual schedule with me is correct and current — it's just the Google view that may be out of sync right now. I'm still retrying in the background, and if it keeps up, reconnecting the calendar will fix it.`,
  },
  hold_expired: {
    he: `ההזמנה שלך לא אושרה בזמן ופג תוקפה. אתם מוזמנים לתזמן שוב בכל עת.`,
    en: `Your booking hold has expired because it wasn't confirmed in time. Feel free to book again whenever you're ready.`,
  },
  // Inbound sync (Phase 3): we applied an owner-originated Google Calendar change.
  calendar_owner_reconcile_applied: {
    he: (n: number) => `סנכרנתי שינוי שביצעת ביומן Google: ${n === 1 ? 'הזמנה אחת בוטלה' : `${n} הזמנות בוטלו`} בהתאם. הלקוחות שהושפעו עודכנו.`,
    en: (n: number) => `I synced a change you made in your Google Calendar: ${n === 1 ? '1 booking was cancelled' : `${n} bookings were cancelled`} to match. The affected customers have been notified.`,
  },
  // Inbound sync (Phase 3): owner change touches many bookings — blast-radius gate.
  calendar_owner_reconcile_gate: {
    he: (n: number) => `שמתי לב שמחקת מ-Google Calendar אירוע שמשפיע על ${n} הזמנות לקוחות. כדי לא לבטל בטעות הזמנות, לא ביטלתי כלום אוטומטית. רוצה שאבטל את כל ${n} ההזמנות? השב/י "כן לבטל" כדי לאשר.`,
    en: (n: number) => `I noticed you removed a Google Calendar event that affects ${n} customer bookings. To avoid mass-cancelling by mistake, I didn't cancel anything automatically. Want me to cancel all ${n} bookings? Reply "yes cancel" to confirm.`,
  },

  // ── Per-conversation pause (manager ops) ─────────────────────────────────────
  pause_conv_confirm: {
    he: (name: string, mins: number) => `⏸ השיחה עם ${name} הושהתה ל-${mins} דקות. תוכל לנהל אותה ישירות דרך Meta Business Suite.`,
    en: (name: string, mins: number) => `⏸ Conversation with ${name} paused for ${mins} minutes. You can handle it directly via Meta Business Suite.`,
  },
  resume_conv_confirm: {
    he: (name: string) => `▶️ השיחה עם ${name} הופעלה מחדש. ה-PA ימשיך לענות.`,
    en: (name: string) => `▶️ Conversation with ${name} resumed. The PA will respond again.`,
  },
  pause_conv_not_found: {
    he: `לא מצאתי לקוח כזה. נסה שם אחר או מספר טלפון.`,
    en: `I couldn't find that customer. Try a different name or phone number.`,
  },
  pause_conv_ambiguous: {
    he: (names: string) => `מצאתי כמה לקוחות תואמים: ${names}. אנא ציין מספר טלפון מלא.`,
    en: (names: string) => `Found multiple matching customers: ${names}. Please provide a full phone number.`,
  },
  pa_paused_customer: {
    he: `אנחנו לא זמינים כרגע לתיאום תורים — נחזור אליכם בהקדם.`,
    en: `We're not available for bookings right now — we'll be in touch shortly.`,
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
