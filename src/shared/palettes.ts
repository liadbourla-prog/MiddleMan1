export interface Palette {
  primary: string
  accent: string
  surface: string
  text: string
  border: string
  accentText: string   // text color on accent background
}

export const PALETTES: Record<string, Palette> = {
  'slate-green':      { primary: '#1e3a2f', accent: '#4ade80', surface: '#f0fdf4', text: '#1a2e24', border: '#bbf7d0', accentText: '#14532d' },
  'warm-terracotta':  { primary: '#7c3d1a', accent: '#f97316', surface: '#fff7ed', text: '#431407', border: '#fed7aa', accentText: '#431407' },
  'midnight-blue':    { primary: '#0f172a', accent: '#3b82f6', surface: '#eff6ff', text: '#0f172a', border: '#bfdbfe', accentText: '#1e3a8a' },
  'dusty-rose':       { primary: '#6b2737', accent: '#f9a8d4', surface: '#fdf2f8', text: '#500724', border: '#fbcfe8', accentText: '#500724' },
  'sage-forest':      { primary: '#2d4a3e', accent: '#86efac', surface: '#f0fdf4', text: '#1a3329', border: '#bbf7d0', accentText: '#14532d' },
  'charcoal-gold':    { primary: '#1c1c1c', accent: '#f59e0b', surface: '#fffbeb', text: '#1c1c1c', border: '#fde68a', accentText: '#451a03' },
  'ocean-teal':       { primary: '#0f4c57', accent: '#06b6d4', surface: '#ecfeff', text: '#083344', border: '#a5f3fc', accentText: '#083344' },
  'lavender-purple':  { primary: '#3b1f6e', accent: '#a855f7', surface: '#faf5ff', text: '#2e1065', border: '#e9d5ff', accentText: '#2e1065' },
  'brick-cream':      { primary: '#8b1a1a', accent: '#d97706', surface: '#fef3c7', text: '#450a0a', border: '#fde68a', accentText: '#451a03' },
  'deep-olive':       { primary: '#3d4a1a', accent: '#a3e635', surface: '#f7fee7', text: '#1a2e05', border: '#d9f99d', accentText: '#1a2e05' },
}

export const DEFAULT_PALETTE = 'midnight-blue'

export function resolvePalette(name: string): Palette {
  return PALETTES[name] ?? PALETTES[DEFAULT_PALETTE]!
}

/** Map a free-text color description to the closest palette name */
export function matchPaletteFromText(text: string): string {
  const lower = text.toLowerCase()
  if (/green|forest|nature|sage/.test(lower)) return 'slate-green'
  if (/orange|terra|warm|earthy/.test(lower)) return 'warm-terracotta'
  if (/blue|navy|midnight|dark blue/.test(lower)) return 'midnight-blue'
  if (/pink|rose|feminine|soft/.test(lower)) return 'dusty-rose'
  if (/sage|mint|light green/.test(lower)) return 'sage-forest'
  if (/gold|black|charcoal|modern/.test(lower)) return 'charcoal-gold'
  if (/teal|ocean|sea|aqua|cyan/.test(lower)) return 'ocean-teal'
  if (/purple|lavender|violet/.test(lower)) return 'lavender-purple'
  if (/brick|red|cream|classic/.test(lower)) return 'brick-cream'
  if (/olive|khaki|earthy green/.test(lower)) return 'deep-olive'
  return DEFAULT_PALETTE
}
