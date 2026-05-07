import type { FastifyInstance } from 'fastify'
import { Storage } from '@google-cloud/storage'
import { SiteSchemaZod } from '../../skills/website-builder/site-schema.js'
import { renderSite } from './renderer.js'
import { buildLlmsTxt, buildRobotsTxt, buildSitemapXml } from './aeo-layer.js'

const BUCKET_NAME = process.env['PREVIEW_BUCKET'] ?? ''
const BUCKET_URL = (process.env['PREVIEW_BUCKET_URL'] ?? '').replace(/\/$/, '')
const SITE_BUILDER_SECRET = process.env['SITE_BUILDER_SECRET'] ?? ''

export async function buildSiteRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown }>('/build-site', async (request, reply) => {
    // Auth check
    const authHeader = request.headers['authorization'] ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (SITE_BUILDER_SECRET && token !== SITE_BUILDER_SECRET) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    // Parse + validate body
    const body = request.body as Record<string, unknown>
    const workflowId = typeof body['workflowId'] === 'string' ? body['workflowId'] : null
    if (!workflowId) {
      return reply.code(400).send({ error: 'workflowId is required' })
    }

    const schemaParse = SiteSchemaZod.safeParse(body['schema'])
    if (!schemaParse.success) {
      return reply.code(400).send({ error: 'Invalid site schema', issues: schemaParse.error.issues })
    }

    const schema = schemaParse.data

    // Derive preview URL from bucket + workflowId
    const siteUrl = BUCKET_URL ? `${BUCKET_URL}/${workflowId}` : `http://localhost:${process.env['PORT'] ?? 3000}/preview/${workflowId}`
    const lastmod = schema.generatedAt.slice(0, 10)

    // Render all pages
    const renderedPages = renderSite(schema, siteUrl)

    // AEO root files
    const llmsTxt = buildLlmsTxt(schema)
    const robotsTxt = buildRobotsTxt(siteUrl)

    const pageUrls = Object.keys(renderedPages).map((file) => {
      const path = file === 'index.html' ? '/' : '/' + file.replace('index.html', '')
      return { url: siteUrl + path, lastmod }
    })
    const sitemap = buildSitemapXml([
      ...pageUrls,
      { url: siteUrl + '/llms.txt', lastmod },
    ])

    // Upload to GCS if bucket is configured, otherwise respond with inline HTML
    const pages: Record<string, string> = {}
    for (const [file] of Object.entries(renderedPages)) {
      pages[file] = `${siteUrl}/${file}`
    }

    if (BUCKET_NAME) {
      const storage = new Storage()
      const bucket = storage.bucket(BUCKET_NAME)
      const prefix = workflowId

      const uploads: Array<Promise<void>> = []

      // HTML pages
      for (const [file, html] of Object.entries(renderedPages)) {
        uploads.push(
          bucket.file(`${prefix}/${file}`).save(html, { contentType: 'text/html; charset=utf-8', metadata: { cacheControl: 'public, max-age=300' } })
        )
      }

      // AEO root files
      uploads.push(bucket.file(`${prefix}/llms.txt`).save(llmsTxt, { contentType: 'text/plain; charset=utf-8' }))
      uploads.push(bucket.file(`${prefix}/robots.txt`).save(robotsTxt, { contentType: 'text/plain; charset=utf-8' }))
      uploads.push(bucket.file(`${prefix}/sitemap.xml`).save(sitemap, { contentType: 'application/xml; charset=utf-8' }))

      try {
        await Promise.all(uploads)
      } catch (err) {
        app.log.error({ event: 'build-site.gcs-upload-failed', workflowId, err })
        return reply.code(500).send({ error: 'GCS upload failed' })
      }

      app.log.info(JSON.stringify({ event: 'build-site.uploaded', workflowId, siteUrl, pageCount: Object.keys(renderedPages).length }))
    } else {
      // Dev mode: store in memory for /preview/:workflowId/* endpoint (registered separately in dev)
      app.log.info(JSON.stringify({ event: 'build-site.dev-mode', workflowId, siteUrl }))
    }

    return reply.send({
      previewUrl: siteUrl + '/',
      pages,
    })
  })
}
