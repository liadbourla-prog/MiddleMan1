import { describe, it, expect } from 'vitest'
import { inferFocusService } from './service-resolution.js'

const SERVICES = [
  { id: 'yoga', name: 'יוגה' },
  { id: 'pilates', name: 'פילאטיס' },
  { id: 'breath', name: 'סדנת נשימות, כוללת סאונה ואמבטיית קרח' },
]

describe('inferFocusService', () => {
  it('resolves the single service the conversation has been about', () => {
    // Mirrors the live failure: assistant proposed breathing, customer is referential.
    const transcript = [
      { role: 'assistant' as const, text: 'מחר יש לנו יוגה, פילאטיס, וגם את סדנת הנשימות. מה מעניין אותך?' },
      { role: 'customer' as const, text: 'מה שדיברנו עליו' },
      { role: 'assistant' as const, text: 'בסדר גמור. אז אנחנו מדברים על סדנת הנשימות למחר.' },
      { role: 'customer' as const, text: 'תרשום אותי' },
    ]
    const r = inferFocusService(transcript, SERVICES)
    expect(r?.id).toBe('breath')
  })

  it('returns null when two services are referenced (genuinely ambiguous)', () => {
    const transcript = [
      { role: 'customer' as const, text: 'אני מתלבט בין יוגה לפילאטיס' },
    ]
    expect(inferFocusService(transcript, SERVICES)).toBeNull()
  })

  it('returns null when no service is referenced', () => {
    const transcript = [
      { role: 'customer' as const, text: 'אני רוצה לקבוע משהו למחר' },
      { role: 'assistant' as const, text: 'בטח, מה תרצה לקבוע?' },
    ]
    expect(inferFocusService(transcript, SERVICES)).toBeNull()
  })

  it('returns the only service when a business has just one', () => {
    expect(inferFocusService([], [{ id: 'a', name: 'Massage' }])?.id).toBe('a')
  })
})
