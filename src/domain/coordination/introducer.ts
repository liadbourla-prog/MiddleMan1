import type { Lang } from '../i18n/t.js'

// Pure: decide how the PA introduces itself when reaching out on the owner's behalf.
// Never emits the "Owner" placeholder (or an empty name) — falls back to the business
// name so the PA can never leak a placeholder or fabricate a personal name.
export function resolveOutreachIntroducer(opts: {
  mode: 'business' | 'owner_name' | null
  businessName: string
  ownerName: string | null
  lang: Lang
}): string {
  const name = opts.ownerName?.trim() ?? ''
  const isPlaceholder = name === '' || name.toLowerCase() === 'owner'
  if (opts.mode === 'owner_name' && !isPlaceholder) {
    return opts.lang === 'he' ? `העוזר/ת של ${name}` : `${name}'s assistant`
  }
  return opts.businessName
}
