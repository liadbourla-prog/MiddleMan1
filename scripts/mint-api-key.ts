import { db } from '../src/db/client.js'
import { businessApiKeys, businesses } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { generateApiKey, type KeyType } from '../src/routes/public-api/auth.js'

async function main() {
  const [businessId, type, label] = process.argv.slice(2)
  if (!businessId || (type !== 'publishable' && type !== 'secret')) {
    console.error('Usage: tsx scripts/mint-api-key.ts <businessId> <publishable|secret> [label]')
    process.exit(1)
  }
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!biz) { console.error(`No business ${businessId}`); process.exit(1) }

  const key = generateApiKey(type as KeyType)
  await db.insert(businessApiKeys).values({
    businessId, type: type as KeyType, keyHash: key.hash, prefix: key.prefix, label: label ?? null,
  })
  console.log(`Minted ${type} key for ${businessId}:`)
  console.log(`  ${key.raw}`)
  console.log('Store it now — it will not be shown again.')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
