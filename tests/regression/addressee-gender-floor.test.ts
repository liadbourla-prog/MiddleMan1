// DO-NOT-REGRESS — Addressee-gender masculine floor (decision 1).
//
// The cardinal invariant of the Hebrew-gender feature: when a person's gender is UNKNOWN, the
// PA addresses them in masculine singular — on EVERY branch — and is byte-identical to the
// pre-feature behavior. Any future gender work must keep this green: it guards against (a) a
// default silently flipping to feminine/neutral, and (b) the signal producers GUESSING a
// gender they are not sure of (which would persist and mis-address a real person).
import { describe, it, expect } from 'vitest'
import { buildVoiceCore, type VoiceChannel } from '../../src/adapters/llm/voice.js'
import { resolveAddresseeGender } from '../../src/domain/identity/addressee-gender.js'
import { genderFromName } from '../../src/domain/identity/hebrew-name-gender.js'
import { inferSelfGenderFromHebrew } from '../../src/domain/identity/hebrew-self-morphology.js'

const CHANNELS: VoiceChannel[] = ['customer', 'manager', 'operator', 'onboarding', 'proactive']

describe('DO-NOT-REGRESS: unknown gender → masculine floor', () => {
  it('every branch addresses masculine when gender is unknown', () => {
    for (const ch of CHANNELS) {
      const core = buildVoiceCore(ch)
      expect(core, ch).toContain('בלשון זכר')
      expect(core, ch).not.toContain('בלשון נקבה')
    }
  })

  it('unknown is byte-identical to explicit male and to null on every branch (no drift)', () => {
    for (const ch of CHANNELS) {
      expect(buildVoiceCore(ch), ch).toBe(buildVoiceCore(ch, 'male'))
      expect(buildVoiceCore(ch), ch).toBe(buildVoiceCore(ch, null))
    }
  })
})

describe('DO-NOT-REGRESS: producers never guess a gender they are unsure of', () => {
  it('the resolver invents nothing from no signals (caller falls back to masculine, persists nothing)', () => {
    expect(resolveAddresseeGender({})).toBeNull()
    expect(resolveAddresseeGender({ stored: null, nameSignal: null, morphologySignal: null })).toBeNull()
  })

  it('the name dictionary never guesses on unisex names', () => {
    for (const n of ['גל', 'שיר', 'רותם', 'עדן', 'אופיר', 'טל', 'נועם', 'יובל', 'עמית', 'אור']) {
      expect(genderFromName(n), n).toBeNull()
    }
  })

  it('the self-morphology detector never guesses on neutral/ambiguous Hebrew', () => {
    expect(inferSelfGenderFromHebrew('אני רוצה לקבוע')).toBeNull()
    expect(inferSelfGenderFromHebrew('קבעתי תור אתמול')).toBeNull()
    expect(inferSelfGenderFromHebrew('מתי אתם פתוחים?')).toBeNull()
  })
})
