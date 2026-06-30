import { describe, it, expect } from 'vitest'
import { deriveGoogleMapsUrl, resolveGoogleMapsUrl } from './maps.js'

describe('deriveGoogleMapsUrl', () => {
  it('builds a key-free Maps search URL with the address url-encoded', () => {
    expect(deriveGoogleMapsUrl('הרצל 1, תל אביב')).toBe(
      'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('הרצל 1, תל אביב'),
    )
  })

  it('trims the address before encoding', () => {
    expect(deriveGoogleMapsUrl('  5 Dizengoff St  ')).toContain(encodeURIComponent('5 Dizengoff St'))
  })
})

describe('resolveGoogleMapsUrl', () => {
  it('prefers the owner-pasted override link over the derived search URL', () => {
    expect(resolveGoogleMapsUrl({ address: 'Herzl 1', googleMapsUrl: 'https://g.page/studio' }))
      .toBe('https://g.page/studio')
  })

  it('derives from the address when there is no override', () => {
    expect(resolveGoogleMapsUrl({ address: 'Herzl 1, Tel Aviv', googleMapsUrl: null }))
      .toBe(deriveGoogleMapsUrl('Herzl 1, Tel Aviv'))
  })

  it('ignores a blank override and falls back to the derived URL', () => {
    expect(resolveGoogleMapsUrl({ address: 'Herzl 1', googleMapsUrl: '   ' }))
      .toBe(deriveGoogleMapsUrl('Herzl 1'))
  })

  it('returns null when there is no address and no override (never fabricates a link)', () => {
    expect(resolveGoogleMapsUrl({ address: null, googleMapsUrl: null })).toBeNull()
    expect(resolveGoogleMapsUrl({})).toBeNull()
  })
})
