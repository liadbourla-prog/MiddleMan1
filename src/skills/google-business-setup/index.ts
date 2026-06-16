import { z } from 'zod'
import { GoogleGenAI } from '@google/genai'
import type {
  Skill,
  SkillContext,
  SkillOutcome,
  WorkflowState,
} from '../../shared/skill-types.js'

// ── LLM ──────────────────────────────────────────────────────────────────────

const ai = new GoogleGenAI({ apiKey: process.env['LLM_API_KEY'] ?? '', apiVersion: 'v1beta' })
const MODEL = 'gemini-2.5-flash'

async function callJson<T>(systemPrompt: string, userMessage: string, schema: z.ZodType<T>): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model: MODEL,
        contents: userMessage,
        config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0, responseMimeType: 'application/json' },
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

// ── Category map (gcid: lookup) ───────────────────────────────────────────────

const CATEGORY_MAP: Record<string, string> = {
  'hair salon': 'gcid:hair_salon', 'hair': 'gcid:hair_salon',
  'barber': 'gcid:barber_shop', 'barber shop': 'gcid:barber_shop',
  'nail salon': 'gcid:nail_salon', 'nails': 'gcid:nail_salon',
  'spa': 'gcid:day_spa', 'day spa': 'gcid:day_spa',
  'massage': 'gcid:massage_therapist', 'massage therapist': 'gcid:massage_therapist',
  'beauty salon': 'gcid:beauty_salon', 'beauty': 'gcid:beauty_salon',
  'yoga': 'gcid:yoga_studio', 'yoga studio': 'gcid:yoga_studio',
  'gym': 'gcid:gym', 'fitness': 'gcid:fitness_center', 'fitness center': 'gcid:fitness_center',
  'personal trainer': 'gcid:personal_trainer',
  'pilates': 'gcid:pilates_studio', 'pilates studio': 'gcid:pilates_studio',
  'physical therapy': 'gcid:physiotherapist', 'physiotherapy': 'gcid:physiotherapist',
  'chiropractor': 'gcid:chiropractor',
  'dentist': 'gcid:dentist', 'dental': 'gcid:dental_clinic',
  'doctor': 'gcid:doctor', 'clinic': 'gcid:medical_clinic',
  'tattoo': 'gcid:tattoo_shop', 'piercing': 'gcid:piercing_shop',
  'eyebrows': 'gcid:eyebrow_bar', 'lashes': 'gcid:eyelash_service',
  'makeup': 'gcid:makeup_artist', 'makeup artist': 'gcid:makeup_artist',
  'photography': 'gcid:photographer', 'photographer': 'gcid:photographer',
  'tutor': 'gcid:tutor', 'tutoring': 'gcid:tutoring_service',
  'accountant': 'gcid:accountant',
  'lawyer': 'gcid:law_office',
  'psychologist': 'gcid:psychologist', 'therapist': 'gcid:mental_health_service',
  'veterinarian': 'gcid:veterinarian', 'vet': 'gcid:veterinarian',
  // Hebrew
  'מספרה': 'gcid:hair_salon', 'ספר': 'gcid:barber_shop',
  'ציפורניים': 'gcid:nail_salon', 'ספא': 'gcid:day_spa',
  'עיסוי': 'gcid:massage_therapist', 'יוגה': 'gcid:yoga_studio',
  'כושר': 'gcid:fitness_center', 'מאמן אישי': 'gcid:personal_trainer',
  'פילאטיס': 'gcid:pilates_studio', 'פיזיותרפיה': 'gcid:physiotherapist',
  'שיניים': 'gcid:dentist', 'רופא': 'gcid:doctor',
  'קעקוע': 'gcid:tattoo_shop', 'צלמות': 'gcid:photographer',
  'פסיכולוג': 'gcid:psychologist', 'מטפל': 'gcid:mental_health_service',
  'וטרינר': 'gcid:veterinarian',
}

function lookupCategoryId(text: string): string {
  const lower = text.toLowerCase().trim()
  return CATEGORY_MAP[lower]
    ?? CATEGORY_MAP[lower.split(' ')[0] ?? '']
    ?? 'gcid:local_business'
}

// ── State & step types ────────────────────────────────────────────────────────

type GmbStep = 'check-existing' | 'oauth' | 'collect-info' | 'collect-photos' | 'create-or-update' | 'verification-guide' | 'complete'

interface GmbState {
  actionChoice?: 'update' | 'done'
  oauthUrl?: string
  category?: string
  categoryId?: string
  serviceArea?: string
  description?: string
  certifications?: string[]
  logoUrl?: string | null
  heroImageUrl?: string | null
  locationId?: string
  profileUrl?: string
  verificationMethod?: 'POSTCARD' | 'PHONE_CALL'
  retryCount?: number
  pendingPhotoUrl?: string
}

// ── Intent helpers ────────────────────────────────────────────────────────────

// Hebrew-safe trailing boundary — a bare `\b` does not match after a Hebrew letter
// at end-of-input (Hebrew is non-word in JS regex without /u), so Hebrew keywords
// silently never match. See business-knowledge-setup for the same fix.
const KW_END = "(?=\\b|$|\\s|[.,!?'\"\\-])"

function isSkipText(text: string): boolean {
  return new RegExp("^(skip|next|later|no|not now|לא|דלג|הבא|אחר כך|pass)" + KW_END, 'i').test(text.trim())
}

function isApproveText(text: string): boolean {
  return new RegExp("^(yes|ok|sure|approve|let'?s go|do it|כן|אוקיי|בסדר|יאלה|קדימה|בטח)" + KW_END, 'i').test(text.trim())
}

function isCancelText(text: string): boolean {
  // Word-bounded "contains" match that is safe for Hebrew (the original `\b…\b`
  // failed on both sides for Hebrew). Requires the keyword to be delimited by
  // start/whitespace/punctuation so e.g. "מבוטל" does not match "בטל".
  return /(?:^|[\s.,!?])(stop|cancel|never mind|exit|quit|עצור|לבטל|ביטול|בטל|בוטל|עזוב|לא צריך)(?=$|[\s.,!?])/i.test(text.trim())
}

function makeReply(ctx: SkillContext, reply: string, sessionComplete = false): SkillOutcome {
  return { handled: true, reply: `${reply}\n[google-business-setup]`, sessionComplete, skillName: 'google-business-setup' }
}

function toRecord(state: GmbState): Record<string, unknown> {
  return state as unknown as Record<string, unknown>
}

function errorReply(ctx: SkillContext): SkillOutcome {
  const msg = ctx.language === 'he'
    ? 'אירעה שגיאה, נסה שוב מאוחר יותר.'
    : 'An error occurred, please try again later.'
  return makeReply(ctx, msg)
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function handleCheckExisting(ctx: SkillContext, wf: WorkflowState, state: GmbState): Promise<SkillOutcome> {
  if (ctx.businessKnowledge.gmbVerified) {
    const text = ctx.message.text.toLowerCase()
    const wantsUpdate = isApproveText(ctx.message.text) || /update|עדכן|yes|כן/.test(text)
    const wantsDone = isSkipText(ctx.message.text) || /good|fine|no|לא|בסדר/.test(text)

    if (wantsUpdate) {
      const oauthUrl = await ctx.requestGmbOAuth()
      await ctx.workflow.advance('oauth', toRecord({ ...state, actionChoice: 'update', oauthUrl }))
      const msg = ctx.language === 'he'
        ? `כדי לעדכן את הפרופיל, צריך לחבר שוב את חשבון Google שלך.\n\n${oauthUrl}\n\nאחרי שתאשר, אמשיך אוטומטית.`
        : `To update your profile, I need to reconnect your Google account.\n\n${oauthUrl}\n\nOnce you authorize, I'll continue automatically.`
      return makeReply(ctx, msg)
    }
    if (wantsDone) {
      await ctx.workflow.complete()
      const done = ctx.language === 'he' ? 'מעולה, הכל בסדר!' : "All good!"
      return { handled: true, reply: done, sessionComplete: true, skillName: 'google-business-setup' }
    }
    const msg = ctx.language === 'he'
      ? 'כבר יש לך פרופיל Google Business מוגדר. רוצה לעדכן אותו, או שהכל בסדר?'
      : "You already have a Google Business profile set up. Want to update it, or are you all good?"
    return makeReply(ctx, msg)
  }

  // No existing profile — go straight to OAuth
  const oauthUrl = await ctx.requestGmbOAuth()
  await ctx.workflow.advance('oauth', toRecord({ ...state, oauthUrl }))
  const msg = ctx.language === 'he'
    ? `כדי להגדיר את הפרופיל, צריך לחבר את חשבון Google שלך.\n\n${oauthUrl}\n\nאחרי שתאשר, אמשיך אוטומטית.`
    : `To set up your profile, I need to connect your Google account.\n\n${oauthUrl}\n\nOnce you authorize, I'll continue automatically.`
  return makeReply(ctx, msg)
}

async function handleOauth(ctx: SkillContext, wf: WorkflowState, state: GmbState): Promise<SkillOutcome> {
  // OAuth callback advances this workflow to collect-info automatically.
  // If manager messages while at this step, check if they've authorized already.
  if (ctx.businessKnowledge.gmbVerified) {
    await ctx.workflow.advance('collect-info', toRecord(state))
    return handleCollectInfo(ctx, { ...wf, step: 'collect-info', state: toRecord(state) }, state)
  }

  const oauthUrl = state.oauthUrl ?? await ctx.requestGmbOAuth()
  const msg = ctx.language === 'he'
    ? `עדיין מחכה לחיבור. השתמש בקישור הזה כדי לאשר:\n\n${oauthUrl}`
    : `Still waiting for authorization. Use this link to connect:\n\n${oauthUrl}`
  return makeReply(ctx, msg)
}

async function handleCollectInfo(ctx: SkillContext, wf: WorkflowState, state: GmbState): Promise<SkillOutcome> {
  const text = ctx.message.text.trim()

  // If arriving here fresh (text is empty or just the tag), ask the question
  if (!text || text === '[google-business-setup]') {
    const msg = ctx.language === 'he'
      ? 'כדי להגדיר את הרישום, ספר לי: מה סוג העסק, באיזה אזור אתם פועלים, ואיך היית מתאר את השירות שלכם במשפט או שניים?'
      : "To set up your listing, tell me: what type of business is this, what area do you serve, and how would you describe what you offer in a sentence or two?"
    return makeReply(ctx, msg)
  }

  const schema = z.object({
    category: z.string().min(2),
    serviceArea: z.string().min(2),
    description: z.string().min(10),
    certifications: z.array(z.string()).default([]),
  })

  const systemPrompt = `Extract business listing info from this message. Return JSON:
{ "category": "<type of business>", "serviceArea": "<city/area>", "description": "<what they offer>", "certifications": [] }
Output ONLY valid JSON.`

  const parsed = await callJson(systemPrompt, text, schema)

  if (!parsed) {
    const msg = ctx.language === 'he'
      ? 'לא הצלחתי להבין את הפרטים. ספר לי שוב — מה סוג העסק, באיזה אזור, ותיאור קצר.'
      : "I couldn't catch the details. Could you tell me again — what type of business, what area, and a brief description?"
    return makeReply(ctx, msg)
  }

  const newState: GmbState = {
    ...state,
    category: parsed.category,
    categoryId: lookupCategoryId(parsed.category),
    serviceArea: parsed.serviceArea,
    description: parsed.description,
    certifications: parsed.certifications ?? [],
  }

  await ctx.workflow.advance('collect-photos', toRecord(newState))

  const msg = ctx.language === 'he'
    ? 'מצוין! רוצה להוסיף תמונות לרישום? תוכל לשלוח לוגו, תמונה של המקום, או תמונת צוות — או לדלג לעכשיו.'
    : "Got it! Would you like to add any photos to your listing? You can send a logo, a photo of the space, or a team photo — or skip for now."
  return makeReply(ctx, msg)
}

async function handleCollectPhotos(ctx: SkillContext, wf: WorkflowState, state: GmbState): Promise<SkillOutcome> {
  const imageUrl = ctx.message.imageUrl
  const text = ctx.message.text.toLowerCase()

  if (!imageUrl && isSkipText(ctx.message.text)) {
    await ctx.workflow.advance('create-or-update', toRecord(state))
    return handleCreateOrUpdate(ctx, { ...wf, step: 'create-or-update', state: toRecord(state) }, state)
  }

  if (imageUrl) {
    // If this is a follow-up message after a photo was sent (text explains which type)
    const isLogo = /logo|לוגו|1/.test(text)
    const isHero = /hero|header|main|banner|space|place|2|ראשי|מקום/.test(text)

    if (!isLogo && !isHero) {
      // Store photo URL temporarily and ask for classification
      await ctx.workflow.advance('collect-photos', toRecord({ ...state, pendingPhotoUrl: imageUrl }))
      const msg = ctx.language === 'he'
        ? 'מה התמונה הזו?\n• לוגו\n• תמונה ראשית (כותרת הדף)\n• תמונת צוות\n• אחר'
        : "What's this photo for?\n• Logo\n• Hero image (top of the page)\n• Team photo\n• Other"
      return makeReply(ctx, msg)
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { pendingPhotoUrl: _p1, ...restState1 } = state
    const newState: GmbState = isLogo
      ? { ...restState1, logoUrl: imageUrl }
      : { ...restState1, heroImageUrl: imageUrl }

    await ctx.workflow.advance('collect-photos', toRecord(newState))
    const msg = ctx.language === 'he'
      ? 'נשמר! רוצה להוסיף עוד תמונות, או שנמשיך?'
      : "Saved! Want to add more photos, or shall we continue?"
    return makeReply(ctx, msg)
  }

  // Text reply while waiting for photo type classification
  if (state.pendingPhotoUrl) {
    const isLogo = /logo|לוגו|1/.test(text)
    const isHero = /hero|header|main|banner|2|ראשי/.test(text)
    const isDone = /done|ready|no|finish|enough|continue|סיימתי|מספיק|ממשיך/.test(text)

    if (isDone || (!isLogo && !isHero)) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { pendingPhotoUrl: _, ...cleanState } = state
      await ctx.workflow.advance('create-or-update', toRecord(cleanState))
      return handleCreateOrUpdate(ctx, { ...wf, step: 'create-or-update', state: toRecord(cleanState) }, cleanState)
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { pendingPhotoUrl: _p2, ...restState2 } = state
    const newState: GmbState = isLogo
      ? { ...restState2, logoUrl: state.pendingPhotoUrl }
      : { ...restState2, heroImageUrl: state.pendingPhotoUrl }

    await ctx.workflow.advance('collect-photos', toRecord(newState))
    const msg = ctx.language === 'he'
      ? 'נשמר! רוצה להוסיף עוד תמונות, או שנמשיך?'
      : "Saved! Want to add more photos, or shall we continue?"
    return makeReply(ctx, msg)
  }

  // Generic "done" or any other text
  const isDone = /done|ready|continue|enough|finish|סיימתי|מספיק|ממשיך/.test(text)
  if (isDone || isSkipText(ctx.message.text)) {
    await ctx.workflow.advance('create-or-update', toRecord(state))
    return handleCreateOrUpdate(ctx, { ...wf, step: 'create-or-update', state: toRecord(state) }, state)
  }

  const msg = ctx.language === 'he'
    ? 'שלח תמונה, או כתוב "דלג" כדי להמשיך ללא תמונות.'
    : "Send a photo, or type \"skip\" to continue without photos."
  return makeReply(ctx, msg)
}

async function handleCreateOrUpdate(ctx: SkillContext, wf: WorkflowState, state: GmbState): Promise<SkillOutcome> {
  const retryCount = state.retryCount ?? 0
  const MAX_RETRIES = 3

  if (state.locationId) {
    await ctx.workflow.advance('verification-guide', toRecord(state))
    return handleVerificationGuide(ctx, { ...wf, step: 'verification-guide', state: toRecord(state) }, state)
  }

  try {
    const result = await ctx.createGmbListing({
      businessName: ctx.business.name,
      categoryId: state.categoryId ?? 'gcid:local_business',
      phone: ctx.caller.phoneNumber,
      address: { streetAddress: '', city: state.serviceArea ?? '', country: 'IL' },
      websiteUrl: ctx.businessKnowledge.websiteUrl ?? null,
      description: state.description ?? ctx.business.name,
      serviceArea: state.serviceArea ? [state.serviceArea] : [],
    })

    const newState: GmbState = { ...state, locationId: result.locationId, profileUrl: result.profileUrl }
    await ctx.saveGmbLocation(result.locationId, result.profileUrl)
    await ctx.workflow.advance('verification-guide', toRecord(newState))
    return handleVerificationGuide(ctx, { ...wf, step: 'verification-guide', state: toRecord(newState) }, newState)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = (err as { status?: number }).status

    if (status && status >= 500 && retryCount < MAX_RETRIES) {
      await ctx.workflow.advance('create-or-update', toRecord({ ...state, retryCount: retryCount + 1 }))
      const msg = ctx.language === 'he'
        ? 'גוגל לא מגיב כרגע, מנסה שוב...'
        : "Google isn't responding right now, trying again..."
      return makeReply(ctx, msg)
    }

    await ctx.workflow.fail({ code: 'GMB_CREATE_FAILED', message, recoverable: false })
    const msg = ctx.language === 'he'
      ? 'לא הצלחתי ליצור את הרישום בגוגל. צרו קשר עם התמיכה.'
      : "Couldn't create the Google listing. Please contact support."
    return makeReply(ctx, msg, true)
  }
}

async function handleVerificationGuide(ctx: SkillContext, wf: WorkflowState, state: GmbState): Promise<SkillOutcome> {
  const text = ctx.message.text.toLowerCase()

  const wantsPostcard = /postcard|mail|דואר|גלויה|post/.test(text)
  const wantsPhone = /phone|call|טלפון|שיחה/.test(text)

  if (!wantsPostcard && !wantsPhone) {
    const msg = ctx.language === 'he'
      ? 'גוגל צריכה לאמת את העסק שלך — בדרך כלל לוקח 5-14 ימים. איזו שיטה מתאימה לך?\n• גלויה בדואר\n• שיחת טלפון'
      : "Google needs to verify your business — this usually takes 5-14 days. Which method works for you?\n• Postcard by mail\n• Phone call"
    return makeReply(ctx, msg)
  }

  const method: 'POSTCARD' | 'PHONE_CALL' = wantsPhone ? 'PHONE_CALL' : 'POSTCARD'

  if (state.locationId) {
    await ctx.requestGmbVerification(state.locationId, method).catch(() => {
      // Non-fatal — continue to complete
    })
  }

  const newState: GmbState = { ...state, verificationMethod: method }
  await ctx.workflow.advance('complete', toRecord(newState))
  return handleComplete(ctx, newState)
}

async function handleComplete(ctx: SkillContext, state: GmbState): Promise<SkillOutcome> {
  await ctx.workflow.complete()

  const profileUrl = state.profileUrl ?? ctx.businessKnowledge.gmbProfileUrl
  const urlLine = profileUrl ? `\n${profileUrl}` : ''
  const msg = ctx.language === 'he'
    ? `הפרופיל שלך ב-Google Business מוכן!${urlLine}\n\nגוגל תשלח אישור תוך מספר ימים.`
    : `Your Google Business profile is live!${urlLine}\n\nGoogle will send confirmation within a few days.`

  return { handled: true, reply: msg, sessionComplete: true, skillName: 'google-business-setup' }
}

// ── Skill export ──────────────────────────────────────────────────────────────

export const googleBusinessSetupSkill: Skill = {
  name: 'google-business-setup',

  canHandle(ctx: SkillContext): boolean {
    if (ctx.workflowState?.skillName === 'google-business-setup') return true
    if (ctx.caller.role !== 'manager') return false
    const t = ctx.message.text
    return (
      /google business|gmb|google maps|google profile/i.test(t) ||
      /פרופיל גוגל|גוגל ביזנס|גוגל מפות|ביזנס פרופיל/.test(t)
    )
  },

  async handle(ctx: SkillContext): Promise<SkillOutcome> {
    try {
      if (ctx.workflowState?.skillName === 'google-business-setup' && isCancelText(ctx.message.text)) {
        await ctx.workflow.fail({ code: 'USER_CANCELLED', message: 'User cancelled', recoverable: false })
        const msg = ctx.language === 'he'
          ? 'הגדרת הפרופיל בוטלה. תוכל להתחיל שוב בכל עת.'
          : 'Profile setup cancelled. You can start again any time.'
        return { handled: true, reply: msg, sessionComplete: true, skillName: this.name }
      }

      const wf: WorkflowState = ctx.workflowState
        ?? await ctx.workflow.create(this.name, 'check-existing')
      const state = (wf.state ?? {}) as GmbState

      switch (wf.step as GmbStep) {
        case 'check-existing': return handleCheckExisting(ctx, wf, state)
        case 'oauth': return handleOauth(ctx, wf, state)
        case 'collect-info': return handleCollectInfo(ctx, wf, state)
        case 'collect-photos': return handleCollectPhotos(ctx, wf, state)
        case 'create-or-update': return handleCreateOrUpdate(ctx, wf, state)
        case 'verification-guide': return handleVerificationGuide(ctx, wf, state)
        case 'complete': return handleComplete(ctx, state)
        default: return errorReply(ctx)
      }
    } catch (err) {
      console.error(`[${this.name}] error:`, err)
      return errorReply(ctx)
    }
  },
}
