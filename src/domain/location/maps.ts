// Google Maps link resolution for a business's physical address.
//
// We never store a derived link: the address is the single source of truth, so a derived URL
// would drift the moment the owner edits the address. Instead we store only the owner's explicit
// override (businesses.googleMapsUrl — e.g. a pasted g.page / Maps "place" link that pins an exact
// location) and derive a search URL from the address text when no override exists. Callers (Branch 4
// facts, the website/GMB skills via SkillBusiness) always go through resolveGoogleMapsUrl.

/** A Google Maps search URL for free-text address — the universal, key-free link form. */
export function deriveGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.trim())}`
}

/**
 * The link to give for this business: the owner's explicit override if set, else a search URL
 * derived from the address, else null (no address on record — never fabricate a link).
 */
export function resolveGoogleMapsUrl(business: {
  address?: string | null
  googleMapsUrl?: string | null
}): string | null {
  const override = business.googleMapsUrl?.trim()
  if (override) return override
  const address = business.address?.trim()
  if (address) return deriveGoogleMapsUrl(address)
  return null
}
