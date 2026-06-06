// Load local env (.env.local then .env) before the quality suite evaluates, so
// LLM_API_KEY is present for the live Pro generation + judge calls. Runs as a
// Vitest setupFile (before the test module imports).
import { config } from 'dotenv'

config({ path: '.env.local' })
config()
