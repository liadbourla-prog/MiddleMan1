import { describe, it, expect } from 'vitest'
import { authorize } from './check.js'

describe('authorize meeting.coordinate', () => {
  it('allows a manager', () => {
    expect(authorize({ role: 'manager' }, 'meeting.coordinate').allowed).toBe(true)
  })
  it('denies a customer', () => {
    expect(authorize({ role: 'customer' }, 'meeting.coordinate').allowed).toBe(false)
  })
  it('denies a delegated_user without the grant', () => {
    expect(authorize({ role: 'delegated_user', delegatedPermissions: new Set() }, 'meeting.coordinate').allowed).toBe(false)
  })
  it('allows a delegated_user with the grant', () => {
    expect(authorize({ role: 'delegated_user', delegatedPermissions: new Set(['meeting.coordinate']) }, 'meeting.coordinate').allowed).toBe(true)
  })
})
