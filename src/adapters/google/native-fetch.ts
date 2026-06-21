import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

// ── Google transport fix: force Node native fetch ────────────────────────────────
//
// Node 22 + gaxios 6 (which uses node-fetch 2) throws ERR_STREAM_PREMATURE_CLOSE inside
// node-fetch's gunzip path on Google's gzipped responses. It is deterministic (gaxios's
// own retries don't help) and hits EVERY Google call: OAuth token exchange, token refresh,
// and all Calendar / GMB reads & writes — i.e. the whole calendar integration is dead on
// the current runtime.
//
// Node's native fetch (undici) decompresses correctly, and gaxios honours a
// `fetchImplementation` override. We point every Google client at native fetch:
//   • service-level calls (google.calendar / GMB)  → google.options()
//   • OAuth2 token exchange + refresh              → each client's transporter.defaults
//
// Pinned-version, root-cause fix — no dependency bump. Can be removed once we move to
// gaxios ≥ 7 (which uses native fetch by default).

const NATIVE_FETCH = globalThis.fetch.bind(globalThis) as unknown

// Service-level requests (calendar.events.*, freebusy, channels, GMB) inherit this.
// Module-load side effect: runs as soon as any Google client module imports this helper.
// Guarded so a mocked `googleapis` (in unit tests) without `.options` is a safe no-op.
if (typeof google.options === 'function') {
  google.options({ fetchImplementation: NATIVE_FETCH as never })
}

/**
 * Route an OAuth2 client's transporter — used for token exchange (`getToken`) and silent
 * token refresh — through native fetch. Preserves any existing transporter defaults.
 */
export function useNativeFetch<T extends OAuth2Client>(client: T): T {
  const transporter = client.transporter as unknown as { defaults?: Record<string, unknown> } | undefined
  if (transporter) {
    transporter.defaults = { ...(transporter.defaults ?? {}), fetchImplementation: NATIVE_FETCH }
  }
  return client
}
