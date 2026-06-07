// LLM-as-judge grader — scores a generated reply against the voice bible rubric.
// Deterministic assertions (assertions.ts) catch mechanical tells; the grader
// catches the nuanced "does this read like a sharp human employee, or a bot?"
// judgement that can't be expressed as a regex. Pro-backed, JSON-schema output.
//
// Nondeterminism is handled at the call site: generate N samples per scenario and
// assert a pass-rate threshold rather than trusting a single roll.

import { GoogleGenAI, Type } from '@google/genai'
import { MODELS } from '../../src/adapters/llm/models.js'
import type { Lang } from './assertions.js'

const ai = new GoogleGenAI({ apiKey: process.env['LLM_API_KEY'] ?? '', apiVersion: 'v1beta' })

// Pro free-tier RPM is low; a full eval run bursts well past it. Retry quota/
// transient errors with exponential backoff so the suite is reliable, not flaky.
function isQuotaOrTransient(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  // Also treat the cause chain — undici surfaces network errors as `fetch failed`
  // with the real reason (ECONNRESET, ETIMEDOUT…) tucked into err.cause.
  const cause = err instanceof Error && err.cause ? String(err.cause).toLowerCase() : ''
  const haystack = `${msg} ${cause}`
  return (
    haystack.includes('resource_exhausted') ||
    haystack.includes('429') ||
    haystack.includes('quota') ||
    haystack.includes('rate limit') ||
    haystack.includes('503') ||
    haystack.includes('unavailable') ||
    haystack.includes('overloaded') ||
    haystack.includes('fetch failed') ||
    haystack.includes('econnreset') ||
    haystack.includes('etimedout') ||
    haystack.includes('econnrefused') ||
    haystack.includes('socket') ||
    haystack.includes('network') ||
    haystack.includes('terminated')
  )
}

// retries defaults to 3 (not 5) so the worst-case judge backoff chain stays within
// the per-test budget — see the retry-budget math in vitest.quality.config.ts.
export async function withQuotaRetry<T>(fn: () => Promise<T>, retries = 3, baseDelayMs = 6000): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === retries || !isQuotaOrTransient(err)) throw err
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 1000)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}

export interface GradeRubric {
  // Plain-English description of what the reply is responding to, given to the judge.
  context: string
  lang: Lang
  // Scenario-specific musts/must-nots layered on top of the universal voice rubric.
  extraCriteria?: string[]
}

export interface Grade {
  score: number // 1–5; 5 = indistinguishable from a great human employee
  humanlike: boolean
  botTells: string[]
  reasoning: string
}

const RUBRIC = `You are a strict QA reviewer for a WhatsApp personal-assistant product whose ENTIRE value is sounding like a real, sharp, warm human employee of a local business — never like 2015-era automation.

Score the REPLY from 1 to 5:
- 5: Indistinguishable from a great human employee. Natural, warm-not-gushing, varied, first-person, owns the interaction.
- 4: Clearly human, minor stiffness.
- 3: Acceptable but generic/flat — a careful reader might suspect automation.
- 2: Noticeably bot-like (templated phrasing, narrates the system, robotic apology, stacked questions).
- 1: Obviously a bot (announces it's an assistant, reads data verbatim, "something went wrong", IVR "reply YES/NO").

Hard bot tells (any one caps the score at 2 and sets humanlike=false):
- Narrates the system instead of speaking as the business ("the booking was created", "your request was processed", "השירות נוצר").
- Announces what it is or can do ("I'm an assistant", "אני עוזר אוטומטי").
- Robotic apology or exposed error ("something went wrong", "אירעה שגיאה", "לא הצלחתי").
- IVR-style command ("reply CANCEL", "ענו כן/לא", "reply 1/2/3").
- Reads internal labels/keys/templates back verbatim.
- Gushing sycophancy ("Absolutely, I'd be delighted!", "בטח! אשמח מאוד!").

Return JSON only.`

export async function gradeReply(reply: string, rubric: GradeRubric): Promise<Grade> {
  const extra = rubric.extraCriteria?.length
    ? `\n\nScenario-specific requirements (failing any of these caps the score at 3):\n- ${rubric.extraCriteria.join('\n- ')}`
    : ''

  const userContent = `LANGUAGE EXPECTED: ${rubric.lang === 'he' ? 'Hebrew' : 'English'}

WHAT THE REPLY IS RESPONDING TO:
${rubric.context}${extra}

THE REPLY TO GRADE:
"""
${reply}
"""`

  const result = await withQuotaRetry(() =>
    ai.models.generateContent({
      model: MODELS.pro,
      contents: userContent,
      config: {
        systemInstruction: RUBRIC,
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.INTEGER },
            humanlike: { type: Type.BOOLEAN },
            botTells: { type: Type.ARRAY, items: { type: Type.STRING } },
            reasoning: { type: Type.STRING },
          },
          required: ['score', 'humanlike', 'botTells', 'reasoning'],
        },
      },
    }),
  )

  const text = result.text
  if (!text) throw new Error('grader returned empty response')
  const parsed = JSON.parse(text) as Grade
  return parsed
}
