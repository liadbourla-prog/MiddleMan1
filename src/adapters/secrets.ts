// Secret store — the only place that puts/gets opaque secrets out of band of the database.
//
// Used by payments credential onboarding (§8 of the Grow design): the raw Grow `apiKey`
// must NEVER land in a DB row, a log line, or a chat transcript. We store it here and keep
// only the returned resource reference (`api_key_ref`) in `business_payment_credentials`.
//
// Two backends, chosen at call time:
//   • Google Secret Manager (prod) — when GOOGLE_CLOUD_PROJECT is set and the backend is not
//     forced to memory. Uses Application Default Credentials, exactly like the Storage and
//     Vertex adapters already do.
//   • In-memory (dev / tests) — process-local map, so local runs and the test suite never
//     need a GCP project or network. Refs are `memory://<uuid>`; lost on restart, which is
//     fine because nothing in dev relies on cross-restart secret durability.
//
// The ref is self-describing (scheme prefix), so getSecret dispatches without extra config.

import { randomUUID } from 'node:crypto'

const MEMORY_SCHEME = 'memory://'

// Lazily-created clients/maps so importing this module is free and test-safe.
let memoryStore: Map<string, string> | undefined
type SecretManagerClient = {
  createSecret(req: unknown): Promise<[{ name?: string | null }]>
  addSecretVersion(req: unknown): Promise<[{ name?: string | null }]>
  accessSecretVersion(req: unknown): Promise<[{ payload?: { data?: Uint8Array | string | null } | null }]>
}
let smClient: SecretManagerClient | undefined

function getMemoryStore(): Map<string, string> {
  if (!memoryStore) memoryStore = new Map()
  return memoryStore
}

function gcpProject(): string {
  return process.env['GOOGLE_CLOUD_PROJECT'] ?? process.env['GCLOUD_PROJECT'] ?? ''
}

// Memory backend when explicitly forced, or whenever there is no GCP project to talk to.
function useMemoryBackend(): boolean {
  return process.env['PAYMENTS_SECRET_BACKEND'] === 'memory' || !gcpProject()
}

async function getSecretManagerClient(): Promise<SecretManagerClient> {
  if (!smClient) {
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager')
    smClient = new SecretManagerServiceClient() as unknown as SecretManagerClient
  }
  return smClient
}

/**
 * Store a secret value and return an opaque reference to it. The reference — never the value
 * — is what callers persist. `logicalName` is a human-readable hint folded into the Secret
 * Manager secret id (e.g. "payments-grow-apikey-<businessId>"); it is not security-bearing.
 */
export async function putSecret(logicalName: string, value: string): Promise<string> {
  if (useMemoryBackend()) {
    const ref = `${MEMORY_SCHEME}${randomUUID()}`
    getMemoryStore().set(ref, value)
    return ref
  }

  const project = gcpProject()
  const client = await getSecretManagerClient()
  // Secret ids must match [A-Za-z0-9_-]; suffix with a uuid so re-connects never collide.
  const secretId = `${sanitizeSecretId(logicalName)}-${randomUUID()}`.slice(0, 255)

  await client.createSecret({
    parent: `projects/${project}`,
    secretId,
    secret: { replication: { automatic: {} } },
  })
  const [version] = await client.addSecretVersion({
    parent: `projects/${project}/secrets/${secretId}`,
    payload: { data: Buffer.from(value, 'utf8') },
  })
  // version.name is the fully-qualified ".../versions/N" resource — store it verbatim.
  if (!version?.name) throw new Error('Secret Manager addSecretVersion returned no version name')
  return version.name
}

/** Resolve a reference produced by putSecret back to its secret value. */
export async function getSecret(ref: string): Promise<string> {
  if (ref.startsWith(MEMORY_SCHEME)) {
    const value = getMemoryStore().get(ref)
    if (value === undefined) throw new Error('Secret not found in memory store (process restarted?)')
    return value
  }

  const client = await getSecretManagerClient()
  const [resp] = await client.accessSecretVersion({ name: ref })
  const data = resp?.payload?.data
  if (data == null) throw new Error('Secret Manager accessSecretVersion returned no payload')
  return typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
}

function sanitizeSecretId(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'secret'
}

// Test-only: reset the in-memory store between cases.
export function __resetMemorySecretStore(): void {
  memoryStore = undefined
}
