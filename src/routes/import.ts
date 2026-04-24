import type { FastifyInstance } from 'fastify'
import { eq, and, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { importTokens, businesses, identities } from '../db/schema.js'
import { processImportFile } from '../domain/onboarding/import.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'

export async function importRoutes(app: FastifyInstance) {
  // Serve the upload page
  app.get<{ Params: { token: string } }>('/import/:token', async (request, reply) => {
    const { token } = request.params

    const [record] = await db
      .select({ expiresAt: importTokens.expiresAt, usedAt: importTokens.usedAt })
      .from(importTokens)
      .where(eq(importTokens.token, token))
      .limit(1)

    if (!record) return reply.status(404).type('text/html').send(errorPage('Link not found or already expired.'))
    if (record.usedAt) return reply.status(410).type('text/html').send(errorPage('This link has already been used.'))
    if (record.expiresAt < new Date()) return reply.status(410).type('text/html').send(errorPage('This link has expired. Ask your PA for a new one.'))

    return reply.type('text/html').send(uploadPage(token))
  })

  // Handle file upload (multipart form POST)
  app.post<{ Params: { token: string } }>('/import/:token', async (request, reply) => {
      const { token } = request.params

      const [record] = await db
        .select()
        .from(importTokens)
        .where(and(eq(importTokens.token, token), isNull(importTokens.usedAt)))
        .limit(1)

      if (!record) return reply.status(410).type('text/html').send(errorPage('Link not found, expired, or already used.'))
      if (record.expiresAt < new Date()) return reply.status(410).type('text/html').send(errorPage('This link has expired.'))

      const [business] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.id, record.businessId))
        .limit(1)

      if (!business) return reply.status(404).type('text/html').send(errorPage('Business not found.'))

      // Mark token as used immediately to prevent double-upload
      await db.update(importTokens).set({ usedAt: new Date() }).where(eq(importTokens.token, token))

      // Parse multipart manually using raw body parsing
      const contentType = request.headers['content-type'] ?? ''
      if (!contentType.includes('multipart/form-data')) {
        return reply.status(400).type('text/html').send(errorPage('Expected a multipart file upload.'))
      }

      const boundary = contentType.split('boundary=')[1]?.trim()
      if (!boundary) return reply.status(400).type('text/html').send(errorPage('Missing multipart boundary.'))

      const rawBuffer = await collectBody(request.raw)
      const files = parseMultipart(rawBuffer, boundary)

      if (files.length === 0) {
        return reply.status(400).type('text/html').send(errorPage('No files received.'))
      }

      const totalSummary = { contacts: 0, services: 0, bookingHistory: 0, errors: [] as string[] }

      for (const { filename, content } of files) {
        const summary = await processImportFile(db, record.businessId, filename, content)
        totalSummary.contacts += summary.contacts
        totalSummary.services += summary.services
        totalSummary.bookingHistory += summary.bookingHistory
        totalSummary.errors.push(...summary.errors)
      }

      // Advance onboarding if still on customer_import step
      if (business.onboardingStep === 'customer_import') {
        await db
          .update(businesses)
          .set({ onboardingStep: 'verify' })
          .where(eq(businesses.id, business.id))
      }

      // Send WhatsApp confirmation to manager
      const waCredentials = business.whatsappPhoneNumberId && business.whatsappAccessToken
        ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
        : undefined

      const parts = []
      if (totalSummary.contacts > 0) parts.push(`${totalSummary.contacts} contacts`)
      if (totalSummary.services > 0) parts.push(`${totalSummary.services} services`)
      if (totalSummary.bookingHistory > 0) parts.push(`${totalSummary.bookingHistory} past bookings`)
      const imported = parts.length > 0 ? parts.join(', ') : 'nothing'
      const errorNote = totalSummary.errors.length > 0
        ? `\n⚠️ ${totalSummary.errors.length} row(s) skipped.`
        : ''

      await sendMessage(
        {
          toNumber: record.managerPhone,
          body: `✅ Import complete! Imported: ${imported}.${errorNote}\n\nSend me a message to confirm your PA is live and working.`,
        },
        waCredentials,
      ).catch(() => {/* non-fatal */})

      app.log.info({ businessId: record.businessId, totalSummary }, 'Import complete')

      return reply.type('text/html').send(successPage(imported))
    },
  )
}

// ── Minimal HTML pages ────────────────────────────────────────────────────────

function uploadPage(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Import Data — PA Setup</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 520px; margin: 48px auto; padding: 0 24px; color: #111; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; }
    p { color: #555; line-height: 1.5; }
    .drop { border: 2px dashed #ccc; border-radius: 12px; padding: 40px 24px; text-align: center; cursor: pointer; transition: border-color .2s; }
    .drop.over { border-color: #25D366; }
    input[type=file] { display: none; }
    button { background: #25D366; color: #fff; border: none; border-radius: 8px; padding: 14px 32px; font-size: 1rem; cursor: pointer; margin-top: 16px; width: 100%; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .hint { font-size: .8rem; color: #888; margin-top: 12px; }
    #status { margin-top: 16px; font-size: .9rem; }
  </style>
</head>
<body>
  <h1>Import your data</h1>
  <p>Upload one or more CSV files. Accepted formats:</p>
  <ul style="color:#555;line-height:1.8">
    <li><b>Contacts:</b> <code>name, phone</code></li>
    <li><b>Services:</b> <code>name, duration_minutes, price</code></li>
    <li><b>Booking history:</b> <code>name, phone, date, service</code></li>
  </ul>
  <form id="form" action="/import/${token}" method="POST" enctype="multipart/form-data">
    <div class="drop" id="drop" onclick="document.getElementById('files').click()">
      <p style="margin:0;font-size:1.1rem">📂 Click or drag files here</p>
      <p style="margin:8px 0 0;font-size:.85rem;color:#888" id="fileNames">No files selected</p>
    </div>
    <input type="file" id="files" name="files" multiple accept=".csv">
    <button type="submit" id="submit" disabled>Upload</button>
  </form>
  <p id="status"></p>
  <p class="hint">This link expires in 30 minutes and can only be used once.</p>
  <script>
    const drop = document.getElementById('drop')
    const input = document.getElementById('files')
    const btn = document.getElementById('submit')
    const names = document.getElementById('fileNames')
    function updateFiles(files) {
      names.textContent = files.length ? Array.from(files).map(f => f.name).join(', ') : 'No files selected'
      btn.disabled = files.length === 0
    }
    input.addEventListener('change', () => updateFiles(input.files))
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over') })
    drop.addEventListener('dragleave', () => drop.classList.remove('over'))
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('over')
      const dt = new DataTransfer()
      Array.from(e.dataTransfer.files).forEach(f => dt.items.add(f))
      input.files = dt.files; updateFiles(input.files)
    })
    document.getElementById('form').addEventListener('submit', () => {
      btn.disabled = true; btn.textContent = 'Uploading...'
    })
  </script>
</body>
</html>`
}

function successPage(imported: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Import Complete</title>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; color: #111; }</style>
</head>
<body>
  <div style="font-size:3rem">✅</div>
  <h1>Import complete!</h1>
  <p>Imported: <b>${imported}</b>.</p>
  <p style="color:#555">Your PA has been notified. You can close this tab and return to WhatsApp.</p>
</body>
</html>`
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error</title>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; color: #111; }</style>
</head>
<body>
  <div style="font-size:3rem">⚠️</div>
  <h1>Something went wrong</h1>
  <p style="color:#555">${message}</p>
</body>
</html>`
}

// ── Multipart body helpers ────────────────────────────────────────────────────

function collectBody(raw: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    raw.on('data', (chunk: Buffer) => chunks.push(chunk))
    raw.on('end', () => resolve(Buffer.concat(chunks)))
    raw.on('error', reject)
  })
}

interface ParsedFile {
  filename: string
  content: string
}

function parseMultipart(buffer: Buffer, boundary: string): ParsedFile[] {
  const delimiter = `--${boundary}`
  const text = buffer.toString('latin1')
  const parts = text.split(delimiter).slice(1)
  const files: ParsedFile[] = []

  for (const part of parts) {
    if (part.trim() === '--' || part.trim() === '') continue
    const [rawHeaders, ...bodyParts] = part.split('\r\n\r\n')
    if (!rawHeaders || bodyParts.length === 0) continue

    const filenameMatch = rawHeaders.match(/filename="([^"]+)"/)
    if (!filenameMatch) continue

    const filename = filenameMatch[1] ?? 'upload.csv'
    const body = bodyParts.join('\r\n\r\n').replace(/\r\n--$/, '').replace(/\r\n$/, '')
    files.push({ filename, content: body })
  }

  return files
}
