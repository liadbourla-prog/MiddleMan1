import { describe, it, expect } from 'vitest'
import { colorWordToGoogleId } from './color-vocab.js'

describe('colorWordToGoogleId', () => {
  it('maps English base colors to their Google colorId', () => {
    expect(colorWordToGoogleId('red')).toBe(11)
    expect(colorWordToGoogleId('orange')).toBe(6)
    expect(colorWordToGoogleId('yellow')).toBe(5)
    expect(colorWordToGoogleId('green')).toBe(10)
    expect(colorWordToGoogleId('blue')).toBe(7)
    expect(colorWordToGoogleId('teal')).toBe(7)
    expect(colorWordToGoogleId('turquoise')).toBe(7)
    expect(colorWordToGoogleId('purple')).toBe(3)
    expect(colorWordToGoogleId('pink')).toBe(4)
    expect(colorWordToGoogleId('gray')).toBe(8)
    expect(colorWordToGoogleId('grey')).toBe(8)
  })

  it('maps Hebrew base colors to their Google colorId', () => {
    expect(colorWordToGoogleId('אדום')).toBe(11)
    expect(colorWordToGoogleId('כתום')).toBe(6)
    expect(colorWordToGoogleId('צהוב')).toBe(5)
    expect(colorWordToGoogleId('ירוק')).toBe(10)
    expect(colorWordToGoogleId('כחול')).toBe(7)
    expect(colorWordToGoogleId('טורקיז')).toBe(7)
    expect(colorWordToGoogleId('סגול')).toBe(3)
    expect(colorWordToGoogleId('ורוד')).toBe(4)
    expect(colorWordToGoogleId('אפור')).toBe(8)
  })

  it('distinguishes light/dark variants', () => {
    expect(colorWordToGoogleId('light green')).toBe(2)
    expect(colorWordToGoogleId('sage')).toBe(2)
    expect(colorWordToGoogleId('ירוק בהיר')).toBe(2)
    expect(colorWordToGoogleId('dark blue')).toBe(9)
    expect(colorWordToGoogleId('navy')).toBe(9)
    expect(colorWordToGoogleId('כחול כהה')).toBe(9)
    expect(colorWordToGoogleId('light purple')).toBe(1)
    expect(colorWordToGoogleId('lavender')).toBe(1)
    expect(colorWordToGoogleId('סגול בהיר')).toBe(1)
  })

  it('accepts canonical Google color names', () => {
    expect(colorWordToGoogleId('Tomato')).toBe(11)
    expect(colorWordToGoogleId('Tangerine')).toBe(6)
    expect(colorWordToGoogleId('Banana')).toBe(5)
    expect(colorWordToGoogleId('Basil')).toBe(10)
    expect(colorWordToGoogleId('Peacock')).toBe(7)
    expect(colorWordToGoogleId('Blueberry')).toBe(9)
    expect(colorWordToGoogleId('Grape')).toBe(3)
    expect(colorWordToGoogleId('Flamingo')).toBe(4)
    expect(colorWordToGoogleId('Graphite')).toBe(8)
    expect(colorWordToGoogleId('Lavender')).toBe(1)
    expect(colorWordToGoogleId('Sage')).toBe(2)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(colorWordToGoogleId('RED')).toBe(11)
    expect(colorWordToGoogleId('  Blue  ')).toBe(7)
    expect(colorWordToGoogleId('DaRk   BlUe')).toBe(9)
    expect(colorWordToGoogleId('Light  Green')).toBe(2)
  })

  it('returns null for unmappable input', () => {
    expect(colorWordToGoogleId('chartreuse')).toBeNull()
    expect(colorWordToGoogleId('rainbow')).toBeNull()
    expect(colorWordToGoogleId('')).toBeNull()
    expect(colorWordToGoogleId('   ')).toBeNull()
    expect(colorWordToGoogleId('בז׳')).toBeNull()
  })
})
