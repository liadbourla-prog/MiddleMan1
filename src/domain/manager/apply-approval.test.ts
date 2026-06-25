import { describe, it, expect } from 'vitest'
import { serviceChangeSchema, policyChangeSchema } from './apply.js'

// Parse paths for the two Branch-3 owner-config entries that drive per-service approval
// (design 2026-06-25): the service flag (service_change.requiresApproval) and the window
// (policy_change subtype 'approval_window'). The apply writers themselves are DB-backed
// (integration-level); these pin the deterministic schema parse the classifier output flows through.

describe('serviceChangeSchema — requiresApproval flag', () => {
  it('parses requiresApproval=true ("require my approval for physio")', () => {
    const parsed = serviceChangeSchema.safeParse({ action: 'update', name: 'Physio', requiresApproval: true })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.requiresApproval).toBe(true)
  })

  it('parses requiresApproval=false ("stop asking me to approve yoga")', () => {
    const parsed = serviceChangeSchema.safeParse({ action: 'update', name: 'Yoga', requiresApproval: false })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.requiresApproval).toBe(false)
  })

  it('absent requiresApproval parses as undefined (no change — never-default)', () => {
    const parsed = serviceChangeSchema.safeParse({ action: 'update', name: 'Yoga' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.requiresApproval).toBeUndefined()
  })

  it('rejects a non-boolean requiresApproval', () => {
    expect(serviceChangeSchema.safeParse({ action: 'update', name: 'Yoga', requiresApproval: 'yes' }).success).toBe(false)
  })
})

describe('policyChangeSchema — approval_window subtype', () => {
  it('parses subtype approval_window with valueHours', () => {
    const parsed = policyChangeSchema.safeParse({ subtype: 'approval_window', valueHours: 48, description: 'give me 48h to approve' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.subtype).toBe('approval_window')
      expect(parsed.data.valueHours).toBe(48)
    }
  })

  it('coerces a numeric-string valueHours', () => {
    const parsed = policyChangeSchema.safeParse({ subtype: 'approval_window', valueHours: '12', description: 'expire after 12h' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.valueHours).toBe(12)
  })

  it('still accepts the pre-existing subtypes (additive change)', () => {
    expect(policyChangeSchema.safeParse({ subtype: 'booking_buffer', valueHours: 2, description: 'x' }).success).toBe(true)
    expect(policyChangeSchema.safeParse({ subtype: 'booking_authority', valueMode: 'owner_approval', description: 'x' }).success).toBe(true)
  })

  it('rejects an unknown subtype', () => {
    expect(policyChangeSchema.safeParse({ subtype: 'nonsense', description: 'x' }).success).toBe(false)
  })
})
