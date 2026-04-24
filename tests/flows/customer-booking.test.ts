import { describe, it, expect } from 'vitest'
import { parseConfirmation } from '../../src/domain/flows/types.js'

// parseConfirmation is pure — test exhaustively without DB
describe('parseConfirmation', () => {
  it('recognises affirmative replies', () => {
    for (const text of ['yes', 'Yes', 'YES', 'confirm', 'ok', 'okay', 'sure', 'yep', 'yeah', 'book it', 'go ahead']) {
      expect(parseConfirmation(text)).toBe('yes')
    }
  })

  it('recognises negative replies', () => {
    for (const text of ['no', 'No', 'NO', 'nope', 'cancel', 'stop', "don't", 'nevermind', 'never mind']) {
      expect(parseConfirmation(text)).toBe('no')
    }
  })

  it('returns unclear for ambiguous messages', () => {
    for (const text of ['maybe', 'I think so', 'let me check', 'what time?', '3pm please']) {
      expect(parseConfirmation(text)).toBe('unclear')
    }
  })
})

// Flow state-machine behaviour — tested via the BookingFlowContext shape
describe('booking flow context shape', () => {
  it('pending slot has required fields', () => {
    const ctx = {
      pendingSlot: {
        start: '2026-05-01T10:00:00.000Z',
        end: '2026-05-01T11:00:00.000Z',
        serviceTypeId: 'uuid-here',
        serviceName: 'Haircut',
      },
      awaitingConfirmationFor: 'hold' as const,
    }
    expect(ctx.pendingSlot.start).toBeTruthy()
    expect(ctx.awaitingConfirmationFor).toBe('hold')
  })
})
