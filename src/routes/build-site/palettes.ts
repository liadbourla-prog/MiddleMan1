// Re-exported from shared so both routes and skills can use the same palette data.
// Skills import from '../../shared/palettes.js'; routes import from here.
export type { Palette } from '../../shared/palettes.js'
export { PALETTES, DEFAULT_PALETTE, resolvePalette, matchPaletteFromText } from '../../shared/palettes.js'
