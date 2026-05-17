// Integration test environment defaults.
// Runs before any test or source module is loaded (referenced from vitest config setupFiles).
// Provides safe defaults for env vars that webhook routing and workers read at module load time.

process.env['PROVIDER_WA_NUMBER'] = process.env['PROVIDER_WA_NUMBER'] ?? '+972599000000'
process.env['OPERATOR_PHONE'] = process.env['OPERATOR_PHONE'] ?? '+972599000001'
process.env['PROVIDER_WA_ACCESS_TOKEN'] = process.env['PROVIDER_WA_ACCESS_TOKEN'] ?? 'test-token'
process.env['PROVIDER_WA_PHONE_NUMBER_ID'] = process.env['PROVIDER_WA_PHONE_NUMBER_ID'] ?? 'test-phone-id'
