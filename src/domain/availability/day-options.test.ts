import { describe, it, expect } from 'vitest'
import { selectPrivateOpeningServices } from './day-options.js'

const svc = (id: string, maxParticipants: number) => ({ id, name: id, maxParticipants })

describe('selectPrivateOpeningServices (WS-C: one booking model per service)', () => {
  it('excludes a service that is already running as a class that day', () => {
    const services = [svc('yoga', 1), svc('breath', 1), svc('pilates', 1)]
    // breath has a class block today → it must NOT also appear as private openings.
    const result = selectPrivateOpeningServices(services, ['breath'])
    expect(result.map((s) => s.id)).toEqual(['yoga', 'pilates'])
  })

  it('excludes group services (cap > 1) from private openings', () => {
    const services = [svc('yoga', 1), svc('group', 12)]
    expect(selectPrivateOpeningServices(services, []).map((s) => s.id)).toEqual(['yoga'])
  })

  it('keeps all private services when none run as classes', () => {
    const services = [svc('yoga', 1), svc('breath', 1)]
    expect(selectPrivateOpeningServices(services, []).map((s) => s.id)).toEqual(['yoga', 'breath'])
  })
})
