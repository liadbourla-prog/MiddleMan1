/**
 * MockGeminiClient for Branch 3 orchestrator testing.
 * Provides a scripted response queue so tests can assert on tool calls
 * and replies without hitting the real Gemini API.
 *
 * Usage:
 *   const mock = new MockGeminiClient()
 *   mock.enqueueToolCall('getCalendarAvailability', { date: '2025-06-01' })
 *   mock.enqueueTextReply('Sure, I have booked that slot.')
 *   // inject mock into orchestrator under test
 *   expect(mock.calls).toHaveLength(2)
 */

export interface MockToolCall {
  type: 'tool_call'
  name: string
  args: Record<string, unknown>
}

export interface MockTextReply {
  type: 'text'
  text: string
}

export type MockResponse = MockToolCall | MockTextReply

/** Simulates one Gemini model turn result */
export interface MockModelTurn {
  toolCalls: MockToolCall[]
  text: string | null
}

/**
 * Records of what the client was asked to generate (for assertions in tests).
 */
export interface MockCallRecord {
  contents: unknown
  tools?: unknown
  config?: unknown
}

export class MockGeminiClient {
  private queue: MockResponse[] = []
  readonly calls: MockCallRecord[] = []

  /**
   * Queue a tool-call response. On the next `generateContent` call,
   * the client will return this as a function_call part.
   */
  enqueueToolCall(name: string, args: Record<string, unknown>): this {
    this.queue.push({ type: 'tool_call', name, args })
    return this
  }

  /**
   * Queue a final text reply. The orchestrator should stop looping after this.
   */
  enqueueTextReply(text: string): this {
    this.queue.push({ type: 'text', text })
    return this
  }

  /** Drain the queue to simulate one model turn (may mix tool calls + text). */
  generateContent(params: { contents: unknown; tools?: unknown; config?: unknown }): MockModelTurn {
    this.calls.push(params)

    const toolCalls: MockToolCall[] = []
    let text: string | null = null

    // Dequeue until we hit a text reply or run out
    while (this.queue.length > 0) {
      const next = this.queue[0]!
      if (next.type === 'tool_call') {
        toolCalls.push(next)
        this.queue.shift()
      } else {
        text = next.text
        this.queue.shift()
        break
      }
    }

    return { toolCalls, text }
  }

  /** Check that the queue is fully exhausted after a test scenario. */
  get isDrained(): boolean {
    return this.queue.length === 0
  }

  reset(): void {
    this.queue = []
    this.calls.length = 0
  }
}

// ── Canned scenario helpers ──────────────────────────────────────────────────

/** Returns a mock client pre-loaded with a simple availability-check → reply scenario. */
export function mockAvailabilityCheck(replyText: string): MockGeminiClient {
  const client = new MockGeminiClient()
  client.enqueueToolCall('getCalendarAvailability', { date: new Date().toISOString().slice(0, 10) })
  client.enqueueTextReply(replyText)
  return client
}

/** Returns a mock client that immediately replies with the given text (no tool calls). */
export function mockDirectReply(text: string): MockGeminiClient {
  const client = new MockGeminiClient()
  client.enqueueTextReply(text)
  return client
}

/** Returns a mock client simulating a booking creation flow. */
export function mockBookingFlow(confirmationText: string): MockGeminiClient {
  const client = new MockGeminiClient()
  client.enqueueToolCall('getCalendarAvailability', { date: new Date().toISOString().slice(0, 10) })
  client.enqueueToolCall('applyInstruction', {
    instructionType: 'booking',
    structuredParams: { slotStart: new Date().toISOString() },
  })
  client.enqueueTextReply(confirmationText)
  return client
}
