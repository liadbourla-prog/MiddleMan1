import { describe, it, expect } from 'vitest'
import { parseManagerChannelCommand } from './operator-commands.js'

describe('parseManagerChannelCommand', () => {
  it('parses CHANNEL CENTRAL <name>', () => {
    expect(parseManagerChannelCommand('CHANNEL CENTRAL Pilates Studio')).toEqual({ mode: 'central', target: 'Pilates Studio' })
  })

  it('parses CHANNEL OWN <number> (case-insensitive)', () => {
    expect(parseManagerChannelCommand('channel own +972501234567')).toEqual({ mode: 'own_number', target: '+972501234567' })
  })

  it('parses the Hebrew central alias', () => {
    expect(parseManagerChannelCommand('ערוץ מרכזי סטודיו פילאטיס')).toEqual({ mode: 'central', target: 'סטודיו פילאטיס' })
  })

  it('parses the Hebrew own alias', () => {
    expect(parseManagerChannelCommand('ערוץ עצמי סטודיו')).toEqual({ mode: 'own_number', target: 'סטודיו' })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseManagerChannelCommand('  CHANNEL CENTRAL  Yoga Place ')).toEqual({ mode: 'central', target: 'Yoga Place' })
  })

  it('returns null without a target', () => {
    expect(parseManagerChannelCommand('CHANNEL CENTRAL')).toBeNull()
    expect(parseManagerChannelCommand('CHANNEL OWN ')).toBeNull()
  })

  it('returns null for unrelated operator commands', () => {
    expect(parseManagerChannelCommand('STATUS ALL')).toBeNull()
    expect(parseManagerChannelCommand('RETRIGGER Pilates website-builder')).toBeNull()
    expect(parseManagerChannelCommand('what is the status of everything?')).toBeNull()
  })
})
