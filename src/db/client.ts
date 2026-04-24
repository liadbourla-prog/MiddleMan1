import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema.js'

const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')

// porsager/postgres v3 does not support the ?host=/socket/path URL syntax
// used by Cloud SQL Auth Proxy on Cloud Run. Parse it manually when detected.
function createConnection() {
  const socketMatch = connectionString!.match(
    /^postgresql:\/\/([^:]+):([^@]+)@\/([^?]+)\?host=(.+)$/
  )
  if (socketMatch) {
    const [, user, password, database, host] = socketMatch as [string, string, string, string, string]
    return postgres({ user, password, database, host, max: 10 })
  }
  return postgres(connectionString!, { max: 10 })
}

const sql = createConnection()
export const db = drizzle(sql, { schema })

export type Db = typeof db
