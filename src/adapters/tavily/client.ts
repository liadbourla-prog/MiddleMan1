import { redis } from '../../redis.js'

const TAVILY_API_URL = 'https://api.tavily.com/search'
const DEFAULT_DAILY_LIMIT = 20
const WINDOW_S = 24 * 60 * 60

function rateLimitKey(businessId: string): string {
  // Key rotates daily by UTC date so the counter resets at midnight UTC
  const date = new Date().toISOString().slice(0, 10)
  return `tavily:ratelimit:${businessId}:${date}`
}

export interface TavilySearchOptions {
  maxResults?: number
  searchDepth?: 'basic' | 'advanced'
  includeDomains?: string[]
  excludeDomains?: string[]
}

export interface TavilySearchResult {
  title: string
  url: string
  content: string
  score: number
}

export interface TavilyResponse {
  results: TavilySearchResult[]
  query: string
}

export class TavilyRateLimitError extends Error {
  constructor(businessId: string) {
    super(`Tavily daily search limit reached for business ${businessId}`)
    this.name = 'TavilyRateLimitError'
  }
}

/**
 * Check and increment the per-business daily Tavily call counter.
 * Returns false if the limit has been reached.
 */
async function checkRateLimit(businessId: string, limit: number): Promise<boolean> {
  const key = rateLimitKey(businessId)
  const count = await redis.incr(key)
  if (count === 1) {
    // First call today — set expiry
    await redis.expire(key, WINDOW_S)
  }
  return count <= limit
}

/**
 * Search the web using Tavily API with per-business daily rate limiting.
 * Throws TavilyRateLimitError if the business has exceeded its daily limit.
 */
export async function tavilySearch(
  businessId: string,
  query: string,
  options: TavilySearchOptions = {},
  dailyLimit = DEFAULT_DAILY_LIMIT,
): Promise<TavilyResponse> {
  const apiKey = process.env['TAVILY_API_KEY']
  if (!apiKey) throw new Error('TAVILY_API_KEY is not configured')

  const allowed = await checkRateLimit(businessId, dailyLimit)
  if (!allowed) throw new TavilyRateLimitError(businessId)

  const payload = {
    api_key: apiKey,
    query,
    max_results: options.maxResults ?? 5,
    search_depth: options.searchDepth ?? 'basic',
    include_domains: options.includeDomains,
    exclude_domains: options.excludeDomains,
  }

  const response = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Tavily API error ${response.status}: ${text}`)
  }

  const data = await response.json() as { results: TavilySearchResult[]; query: string }
  return { results: data.results ?? [], query: data.query ?? query }
}

/**
 * Get the remaining Tavily call budget for a business today.
 */
export async function getTavilyBudgetRemaining(businessId: string, dailyLimit = DEFAULT_DAILY_LIMIT): Promise<number> {
  const key = rateLimitKey(businessId)
  const count = parseInt(await redis.get(key) ?? '0', 10)
  return Math.max(0, dailyLimit - count)
}
