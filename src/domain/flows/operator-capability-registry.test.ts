import { describe, it, expect } from 'vitest'
import { registry } from '../../skills/index.js'
import { registeredSkillNames } from './operator-capability-registry.js'

describe('operator capability registry', () => {
  it('every registered skill has an operator capability entry', () => {
    const skillNames = registry.map((s) => s.name)
    const missing = skillNames.filter((name) => !registeredSkillNames.includes(name))
    expect(missing, `Add entries to operator-capability-registry.ts for: ${missing.join(', ')}`).toEqual([])
  })
})
