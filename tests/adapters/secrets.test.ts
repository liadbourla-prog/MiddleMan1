import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { putSecret, getSecret, __resetMemorySecretStore } from '../../src/adapters/secrets.js'

// With no GOOGLE_CLOUD_PROJECT the store uses its in-memory backend — exactly the dev/test
// path. We assert the ref is NOT the raw value (the whole point: only the ref is persisted).
describe('secret store — in-memory backend (dev/test)', () => {
  const savedProject = process.env['GOOGLE_CLOUD_PROJECT']
  const savedBackend = process.env['PAYMENTS_SECRET_BACKEND']

  beforeEach(() => {
    delete process.env['GOOGLE_CLOUD_PROJECT']
    process.env['PAYMENTS_SECRET_BACKEND'] = 'memory'
    __resetMemorySecretStore()
  })
  afterEach(() => {
    if (savedProject === undefined) delete process.env['GOOGLE_CLOUD_PROJECT']
    else process.env['GOOGLE_CLOUD_PROJECT'] = savedProject
    if (savedBackend === undefined) delete process.env['PAYMENTS_SECRET_BACKEND']
    else process.env['PAYMENTS_SECRET_BACKEND'] = savedBackend
  })

  it('round-trips a value through an opaque ref', async () => {
    const ref = await putSecret('payments-grow-apikey-biz1', 'super-secret-key')
    expect(ref).not.toContain('super-secret-key')
    expect(ref.startsWith('memory://')).toBe(true)
    expect(await getSecret(ref)).toBe('super-secret-key')
  })

  it('mints distinct refs for repeated stores', async () => {
    const a = await putSecret('k', 'v1')
    const b = await putSecret('k', 'v2')
    expect(a).not.toBe(b)
    expect(await getSecret(a)).toBe('v1')
    expect(await getSecret(b)).toBe('v2')
  })

  it('throws on an unknown ref', async () => {
    await expect(getSecret('memory://does-not-exist')).rejects.toThrow()
  })
})
