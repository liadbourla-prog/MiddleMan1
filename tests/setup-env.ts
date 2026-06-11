// Unit-test env shim. Several modules (e.g. src/adapters/llm/client.ts) guard at
// import time on LLM_API_KEY. Unit tests never make a live LLM call, so a dummy
// key is enough to let those modules load. A real key (if exported) still wins.
process.env['LLM_API_KEY'] ??= 'test-key-unit'
// src/db/client.ts guards on DATABASE_URL at import time. porsager/postgres
// connects lazily, so a dummy URL lets modules load without a live DB; unit
// tests that exercise DB paths use their own mocks/throwing stubs.
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test'
