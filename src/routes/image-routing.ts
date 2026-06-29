/**
 * Pure decision helper for inbound image messages (INJ6).
 *
 * A WhatsApp image message can carry a text *caption* in `msg.body`. Historically both
 * image-bounce sites in webhook.ts fell straight to the non-text "I only understand text"
 * fallback and `return`ed — discarding the caption even when the customer had typed a real
 * booking under the photo. This helper makes the routing decision explicit and testable.
 *
 * Extracted into its own module (mirroring `contact-gate.ts`) so the logic can be unit-tested
 * without importing webhook.ts, which pulls in db/client.js (throws at import time without
 * DATABASE_URL) and the LLM adapters.
 *
 * Decisions:
 *  - `upload_for_skill`      — an image-skill is active AND credentials exist to upload; the
 *                              image bytes are the payload. Caption (if any) rides along.
 *  - `route_caption_as_text` — no skill will consume the image, but a caption is present. The
 *                              caption carries the intent; route it through the normal text flow
 *                              and ignore the image bytes.
 *  - `bounce_non_text`       — no skill consumes the image AND there is no caption. Genuinely
 *                              nothing to act on → send the non-text fallback.
 */
export type ImageDisposition = 'upload_for_skill' | 'route_caption_as_text' | 'bounce_non_text'

export function classifyImageMessage(opts: {
  /** Whether `msg.body` holds a non-empty caption. */
  hasCaption: boolean
  /** Whether an image-skill is active AND credentials exist to upload the image. */
  imageSkillUploadable: boolean
}): ImageDisposition {
  if (opts.imageSkillUploadable) return 'upload_for_skill'
  if (opts.hasCaption) return 'route_caption_as_text'
  return 'bounce_non_text'
}
