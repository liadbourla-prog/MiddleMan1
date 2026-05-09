/**
 * Structured JSON logging for the Branch 3 orchestrator.
 * Emits GCP Cloud Logging-compatible JSON to stdout.
 * Each iteration of the Gemini function-calling loop produces one log entry.
 */

export type OrchestratorLogSeverity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR'

export interface OrchestratorIterationLog {
  event: 'orchestrator.iteration'
  severity: OrchestratorLogSeverity
  businessId: string
  sessionId: string
  messageId: string
  iteration: number
  /** Tool calls the model requested in this iteration */
  toolCalls: Array<{ name: string; argsPreview: string }>
  /** Results returned from tool execution */
  toolResults: Array<{ name: string; status: 'ok' | 'error'; preview: string }>
  durationMs: number
  timestamp: string
}

export interface OrchestratorCompletionLog {
  event: 'orchestrator.completion'
  severity: OrchestratorLogSeverity
  businessId: string
  sessionId: string
  messageId: string
  totalIterations: number
  finalReply: string | null
  totalDurationMs: number
  timestamp: string
}

export interface OrchestratorErrorLog {
  event: 'orchestrator.error'
  severity: 'ERROR'
  businessId: string
  sessionId: string
  messageId: string
  error: string
  iteration?: number
  timestamp: string
}

function emit(entry: object): void {
  console.log(JSON.stringify(entry))
}

function preview(value: unknown, maxLen = 120): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str
}

export function logOrchestratorIteration(params: {
  businessId: string
  sessionId: string
  messageId: string
  iteration: number
  toolCalls: Array<{ name: string; args: unknown }>
  toolResults: Array<{ name: string; status: 'ok' | 'error'; result: unknown }>
  durationMs: number
}): void {
  const entry: OrchestratorIterationLog = {
    event: 'orchestrator.iteration',
    severity: 'DEBUG',
    businessId: params.businessId,
    sessionId: params.sessionId,
    messageId: params.messageId,
    iteration: params.iteration,
    toolCalls: params.toolCalls.map((tc) => ({ name: tc.name, argsPreview: preview(tc.args) })),
    toolResults: params.toolResults.map((tr) => ({ name: tr.name, status: tr.status, preview: preview(tr.result) })),
    durationMs: params.durationMs,
    timestamp: new Date().toISOString(),
  }
  emit(entry)
}

export function logOrchestratorCompletion(params: {
  businessId: string
  sessionId: string
  messageId: string
  totalIterations: number
  finalReply: string | null
  totalDurationMs: number
}): void {
  const entry: OrchestratorCompletionLog = {
    event: 'orchestrator.completion',
    severity: 'INFO',
    businessId: params.businessId,
    sessionId: params.sessionId,
    messageId: params.messageId,
    totalIterations: params.totalIterations,
    finalReply: params.finalReply ? preview(params.finalReply, 200) : null,
    totalDurationMs: params.totalDurationMs,
    timestamp: new Date().toISOString(),
  }
  emit(entry)
}

export function logOrchestratorError(params: {
  businessId: string
  sessionId: string
  messageId: string
  error: unknown
  iteration?: number
}): void {
  const entry: OrchestratorErrorLog = {
    event: 'orchestrator.error',
    severity: 'ERROR',
    businessId: params.businessId,
    sessionId: params.sessionId,
    messageId: params.messageId,
    error: params.error instanceof Error ? params.error.message : String(params.error),
    ...(params.iteration !== undefined && { iteration: params.iteration }),
    timestamp: new Date().toISOString(),
  }
  emit(entry)
}
