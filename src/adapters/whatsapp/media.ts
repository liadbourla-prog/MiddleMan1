import { Storage } from '@google-cloud/storage'
import { randomUUID } from 'crypto'

const MEDIA_BUCKET = process.env['MEDIA_BUCKET'] ?? ''
const MEDIA_BUCKET_URL = process.env['MEDIA_BUCKET_URL'] ?? ''

const storage = new Storage()

function extFromMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  }
  return map[mimeType] ?? 'bin'
}

export async function downloadAndUploadMedia(params: {
  mediaId: string
  accessToken: string
  businessId: string
  mediaType?: string
}): Promise<{ ok: true; publicUrl: string; mediaType: string } | { ok: false; error: string }> {
  const { mediaId, accessToken, businessId, mediaType: hintMediaType } = params

  if (!MEDIA_BUCKET || !MEDIA_BUCKET_URL) {
    return { ok: false, error: 'MEDIA_BUCKET or MEDIA_BUCKET_URL env var not set' }
  }

  try {
    // Step 1: Resolve media URL from Graph API
    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!metaRes.ok) {
      return { ok: false, error: `Graph API metadata fetch failed: ${metaRes.status}` }
    }
    const meta = await metaRes.json() as { url?: string; mime_type?: string }
    const mediaUrl = meta.url
    const mimeType = meta.mime_type ?? hintMediaType ?? 'image/jpeg'

    if (!mediaUrl) {
      return { ok: false, error: 'Graph API returned no media URL' }
    }

    // Step 2: Download binary from the resolved URL (URLs expire in ~5 min — must be synchronous)
    const downloadRes = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!downloadRes.ok) {
      return { ok: false, error: `Media download failed: ${downloadRes.status}` }
    }
    const buffer = Buffer.from(await downloadRes.arrayBuffer())

    // Step 3: Upload to GCS
    const ext = extFromMimeType(mimeType)
    const objectPath = `business-media/${businessId}/${randomUUID()}.${ext}`
    const bucket = storage.bucket(MEDIA_BUCKET)
    const file = bucket.file(objectPath)

    await file.save(buffer, {
      contentType: mimeType,
      metadata: { cacheControl: 'public, max-age=31536000' },
      public: true,
    })

    const publicUrl = `${MEDIA_BUCKET_URL.replace(/\/$/, '')}/${objectPath}`
    return { ok: true, publicUrl, mediaType: mimeType }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}
