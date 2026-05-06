import { GoogleGenAI } from '@google/genai'
import { sim } from './runner.js'
import type { SimContext, SimResponse } from './runner.js'

const LLM_API_KEY = process.env['LLM_API_KEY'] ?? ''

export interface AgentTurn {
  sent: string
  response: SimResponse
}

export interface AgentResult {
  success: boolean
  turns: AgentTurn[]
  finalState: SimResponse | null
  failureReason: string | null
}

// System prompt for the customer-simulating agent
function buildSystemPrompt(
  goal: string,
  lang: 'he' | 'en',
  businessName: string,
  serviceName: string,
  slotHint: string,
): string {
  if (lang === 'he') {
    return `אתה משחק תפקיד של לקוח שמתקשר עם עסק בשם "${businessName}" דרך WhatsApp.
המטרה שלך: ${goal}
שירות רלוונטי: ${serviceName}
מועד מוצע: ${slotHint}

כללים:
- כתוב בעברית בלבד, משפטים קצרים כמו WhatsApp אמיתי
- כשהבוט שואל על תאריך או שעה — ספק תמיד את שניהם יחד, לדוגמה: "${slotHint}"
- כשהבוט שואל לאישור (לאשר? / כן / לא) — ענה "כן" עד שהתור אושר לחלוטין
- "אושר לחלוטין" פירושו שהבוט שלח הודעת אישור ✅ — לא רק שהוצגו פרטי התור
- ענה "DONE" רק אחרי שהבוט אישר את התור בצורה סופית
- אם נתקלת בשגיאה חמורה שמונעת את המטרה — ענה "FAIL: [סיבה]"
- אל תספק הסברים, רק הודעות WhatsApp רגילות`
  }

  return `You are playing the role of a customer messaging a business called "${businessName}" on WhatsApp.
Your goal: ${goal}
Relevant service: ${serviceName}
Suggested slot: ${slotHint}

Rules:
- Write in English only, short messages as on real WhatsApp
- When the bot asks for a date or time — always provide both together, e.g. "${slotHint}"
- When the bot asks for confirmation (confirm? / yes / no) — reply "yes" until the booking is fully confirmed
- "Fully confirmed" means the bot sent a confirmation message (✅ or "Booking confirmed") — NOT just showing the booking details
- Reply "DONE" only after the bot has sent a final confirmation of the booking
- If you hit a serious error preventing the goal — reply "FAIL: [reason]"
- No explanations, only natural WhatsApp messages`
}

export async function agentRun(opts: {
  goal: string
  lang: 'he' | 'en'
  ctx: SimContext
  businessName: string
  serviceName: string
  slotHint: string
  maxTurns?: number
}): Promise<AgentResult> {
  const { goal, lang, ctx, businessName, serviceName, slotHint, maxTurns = 12 } = opts

  if (!LLM_API_KEY) {
    return {
      success: false,
      turns: [],
      finalState: null,
      failureReason: 'LLM_API_KEY not set — LLM agent skipped',
    }
  }

  const agentAi = new GoogleGenAI({ apiKey: LLM_API_KEY, apiVersion: 'v1beta' })

  const systemPrompt = buildSystemPrompt(goal, lang, businessName, serviceName, slotHint)
  const turns: AgentTurn[] = []
  const history: string[] = []

  for (let i = 0; i < maxTurns; i++) {
    const historyBlock = history.length > 0
      ? `\nConversation so far:\n${history.join('\n')}\n\nWhat do you say next?`
      : lang === 'he'
        ? '\nשלח את ההודעה הראשונה שלך לעסק:'
        : '\nSend your first message to the business:'

    let nextMessage = ''
    for (let attempt = 0; attempt < 3 && !nextMessage; attempt++) {
      const result = await agentAi.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: historyBlock,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 512,
          temperature: 0.2,
        },
      }).catch((e: unknown) => {
        if (process.env['LLM_DEBUG']) console.error('[Agent] generateContent threw:', (e as Error)?.message?.slice(0, 150))
        return null
      })
      nextMessage = result?.text?.trim() ?? ''
    }

    if (!nextMessage) {
      return { success: false, turns, finalState: turns.at(-1)?.response ?? null, failureReason: 'Agent produced empty message after 3 attempts' }
    }
    if (nextMessage === 'DONE') {
      const lastState = turns.at(-1)?.response
      // If the booking is still held (not confirmed), the agent said DONE prematurely.
      // Override: send the confirmation "yes" ourselves and continue.
      if (lastState?.bookingState === 'held' || lastState?.sessionState === 'waiting_confirmation') {
        const confirmMsg = lang === 'he' ? 'כן' : 'yes'
        const confirmResponse = await sim(ctx, confirmMsg)
        turns.push({ sent: confirmMsg, response: confirmResponse })
        history.push(`Customer: ${confirmMsg}`)
        history.push(`Bot: ${confirmResponse.replies[0] ?? '(no reply)'}`)
        if (confirmResponse.bookingState === 'confirmed' && confirmResponse.sessionState === 'completed') {
          return { success: true, turns, finalState: confirmResponse, failureReason: null }
        }
        // Fall through to let the loop continue
        continue
      }
      return { success: true, turns, finalState: lastState ?? null, failureReason: null }
    }
    if (nextMessage.startsWith('FAIL:')) {
      return { success: false, turns, finalState: turns.at(-1)?.response ?? null, failureReason: nextMessage }
    }

    const response = await sim(ctx, nextMessage)
    turns.push({ sent: nextMessage, response })

    const botReply = response.replies[0] ?? '(no reply)'
    history.push(`Customer: ${nextMessage}`)
    history.push(`Bot: ${botReply}`)

    // Auto-detect success: booking confirmed and session complete
    if (response.bookingState === 'confirmed' && response.sessionState === 'completed') {
      return { success: true, turns, finalState: response, failureReason: null }
    }
    // Auto-detect cancellation success
    if (goal.toLowerCase().includes('cancel') && response.bookingState === 'cancelled') {
      return { success: true, turns, finalState: response, failureReason: null }
    }
  }

  return {
    success: false,
    turns,
    finalState: turns.at(-1)?.response ?? null,
    failureReason: `Goal not achieved after ${maxTurns} turns`,
  }
}
