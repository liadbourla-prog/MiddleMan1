/**
 * Unit tests for isAuthenticatedPush — the P6 (SYNC6) authentication gate for
 * Google Calendar push notifications. Pure function; no DB or network needed.
 *
 * Red→Green guard: these must all pass after the fix in inbound-sync.ts.
 */
import { describe, it, expect } from 'vitest'
import { isAuthenticatedPush } from './inbound-sync.js'

const VALID_CHANNEL = {
  channelToken: 'secret-tok-abc123',
  resourceId: 'rid-xyz789',
}

const VALID_HEADERS = {
  channelToken: 'secret-tok-abc123',
  resourceId: 'rid-xyz789',
}

describe('isAuthenticatedPush — P6 / SYNC6 authentication gate', () => {
  it('returns true when token AND resourceId both present and match', () => {
    expect(isAuthenticatedPush(VALID_CHANNEL, VALID_HEADERS)).toBe(true)
  })

  it('rejects a forged/wrong incoming token (correct resourceId)', () => {
    expect(
      isAuthenticatedPush(VALID_CHANNEL, { ...VALID_HEADERS, channelToken: 'bad-token' }),
    ).toBe(false)
  })

  it('rejects when incoming token is missing/undefined', () => {
    expect(
      isAuthenticatedPush(VALID_CHANNEL, { ...VALID_HEADERS, channelToken: undefined }),
    ).toBe(false)
  })

  it('rejects when stored channelToken is null — SYNC6 core: null stored token must NOT accept any push', () => {
    expect(
      isAuthenticatedPush({ ...VALID_CHANNEL, channelToken: null }, VALID_HEADERS),
    ).toBe(false)
  })

  it('rejects when stored channelToken is undefined', () => {
    expect(
      isAuthenticatedPush({ ...VALID_CHANNEL, channelToken: undefined }, VALID_HEADERS),
    ).toBe(false)
  })

  it('rejects a correct token but wrong/forged incoming resourceId', () => {
    expect(
      isAuthenticatedPush(VALID_CHANNEL, { ...VALID_HEADERS, resourceId: 'forged-rid' }),
    ).toBe(false)
  })

  it('rejects a correct token but missing incoming resourceId', () => {
    expect(
      isAuthenticatedPush(VALID_CHANNEL, { ...VALID_HEADERS, resourceId: undefined }),
    ).toBe(false)
  })

  it('rejects when stored resourceId is null', () => {
    expect(
      isAuthenticatedPush({ ...VALID_CHANNEL, resourceId: null }, VALID_HEADERS),
    ).toBe(false)
  })

  it('rejects when stored resourceId is undefined', () => {
    expect(
      isAuthenticatedPush({ ...VALID_CHANNEL, resourceId: undefined }, VALID_HEADERS),
    ).toBe(false)
  })

  it('rejects when both token and resourceId are wrong', () => {
    expect(
      isAuthenticatedPush(VALID_CHANNEL, { channelToken: 'bad', resourceId: 'bad' }),
    ).toBe(false)
  })
})
