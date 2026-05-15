import type { FastifyInstance } from 'fastify'
import { google } from 'googleapis'
import { eq, and, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses, identities, skillWorkflows } from '../db/schema.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { getPrompt } from '../domain/onboarding/steps.js'
import { t, type Lang } from '../domain/i18n/t.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import { advanceWorkflow } from '../domain/skills/workflow-helpers.js'

function buildOAuth2Client() {
  return new google.auth.OAuth2(
    process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_CLIENT_SECRET'],
    process.env['GOOGLE_REDIRECT_URI'],
  )
}

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar']
const GMB_SCOPE = 'https://www.googleapis.com/auth/business.manage'

type OAuthState = { businessId: string; purpose: 'calendar' | 'gmb' }

function parseOAuthState(raw: string): OAuthState {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && 'businessId' in parsed) {
      return parsed as OAuthState
    }
  } catch {
    // plain UUID — legacy calendar flow
  }
  return { businessId: raw, purpose: 'calendar' }
}

const OAUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calendar Connected</title>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; color: #111; }</style>
</head>
<body>
  <div style="font-size:3rem">✅</div>
  <h1>Google Calendar connected!</h1>
  <p style="color:#555">You can close this tab and return to WhatsApp — your PA will confirm there.</p>
</body>
</html>`

export async function oauthRoutes(app: FastifyInstance) {
  app.get('/oauth-success', async (_request, reply) => {
    return reply.type('text/html').send(OAUTH_SUCCESS_HTML)
  })
  // Step 1 — redirect manager to Google consent screen
  // Usage: GET /oauth/google?businessId=<uuid>
  app.get<{ Querystring: { businessId?: string } }>('/oauth/google', async (request, reply) => {
    const { businessId } = request.query

    if (!businessId) {
      return reply.status(400).send('Missing businessId query parameter')
    }

    const [business] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1)

    if (!business) {
      return reply.status(404).send('Business not found')
    }

    const auth = buildOAuth2Client()
    const url = auth.generateAuthUrl({
      access_type: 'offline',
      scope: CALENDAR_SCOPES,
      prompt: 'consent',
      state: JSON.stringify({ businessId, purpose: 'calendar' }),
    })

    return reply.redirect(url)
  })

  // GMB OAuth — GET /oauth/gmb?businessId=<uuid>
  app.get<{ Querystring: { businessId?: string } }>('/oauth/gmb', async (request, reply) => {
    const { businessId } = request.query

    if (!businessId) {
      return reply.status(400).send('Missing businessId query parameter')
    }

    const [business] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1)

    if (!business) {
      return reply.status(404).send('Business not found')
    }

    const auth = buildOAuth2Client()
    const url = auth.generateAuthUrl({
      access_type: 'offline',
      scope: [GMB_SCOPE],
      prompt: 'consent',
      state: JSON.stringify({ businessId, purpose: 'gmb' }),
    })

    return reply.redirect(url)
  })

  // Step 2 — Google redirects back here with auth code (calendar AND GMB)
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/oauth/google/callback',
    async (request, reply) => {
      const { code, state: rawState, error } = request.query

      if (error) {
        app.log.warn({ error }, 'Google OAuth denied')
        return reply.status(400).send(`Google OAuth error: ${error}`)
      }

      if (!code || !rawState) {
        return reply.status(400).send('Missing code or state')
      }

      const { businessId, purpose } = parseOAuthState(rawState)

      const [business] = await db
        .select({ id: businesses.id })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1)

      if (!business) {
        return reply.status(404).send('Business not found')
      }

      const auth = buildOAuth2Client()
      const { tokens } = await auth.getToken(code)

      if (!tokens.refresh_token) {
        return reply
          .status(400)
          .send('Google did not return a refresh token. Re-authorize with prompt=consent.')
      }

      if (purpose === 'gmb') {
        // Store GMB refresh token and advance any active google-business-setup workflow
        await db
          .update(businesses)
          .set({ gmbRefreshToken: tokens.refresh_token })
          .where(eq(businesses.id, businessId))

        // Find manager identity for workflow lookup
        const [managerIdentity] = await db
          .select({ id: identities.id })
          .from(identities)
          .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
          .limit(1)

        if (managerIdentity) {
          const [activeWorkflow] = await db
            .select()
            .from(skillWorkflows)
            .where(and(eq(skillWorkflows.identityId, managerIdentity.id), eq(skillWorkflows.skillName, 'google-business-setup'), eq(skillWorkflows.status, 'active')))
            .limit(1)

          if (activeWorkflow && activeWorkflow.step === 'oauth') {
            await advanceWorkflow(db, activeWorkflow.id, 'collect-info', activeWorkflow.state as Record<string, unknown>, activeWorkflow.version)
              .catch((err) => app.log.warn({ err }, 'Failed to advance GMB workflow after OAuth'))
          }
        }

        app.log.info({ businessId }, 'GMB OAuth completed — refresh token stored')
        return reply.redirect('/oauth-success')
      }

      // Calendar flow (purpose === 'calendar' or legacy)
      await db
        .update(businesses)
        .set({ googleRefreshToken: tokens.refresh_token })
        .where(eq(businesses.id, businessId))

      const [updatedBusiness] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1)

      // Advance onboarding step if still waiting for calendar
      if (updatedBusiness?.onboardingStep === 'calendar') {
        await db
          .update(businesses)
          .set({ onboardingStep: 'customer_import' })
          .where(eq(businesses.id, businessId))
      }

      // Send WhatsApp confirmation to manager
      const [managerIdentity] = await db
        .select({ phoneNumber: identities.phoneNumber })
        .from(identities)
        .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
        .limit(1)

      if (managerIdentity && updatedBusiness) {
        const lang: Lang = (updatedBusiness.defaultLanguage as Lang | null | undefined) ?? 'he'
        const waCredentials = updatedBusiness.whatsappPhoneNumberId && updatedBusiness.whatsappAccessToken
          ? { accessToken: updatedBusiness.whatsappAccessToken, phoneNumberId: updatedBusiness.whatsappPhoneNumberId }
          : undefined

        // Fetch next 7 days of calendar events as a preview
        let calendarPreview = ''
        try {
          const calClient = createCalendarClient({
            accessToken: tokens.access_token ?? '',
            refreshToken: tokens.refresh_token,
            calendarId: updatedBusiness.googleCalendarId,
            calendarMode: 'google',
          })
          const now = new Date()
          const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60_000)
          const events = await calClient.listEvents(now, weekAhead)
          if (events.length > 0) {
            const locale = lang === 'he' ? 'he-IL' : 'en-GB'
            const tz = updatedBusiness.timezone ?? 'UTC'
            const lines = events.slice(0, 10).map((ev) => {
              const dateStr = ev.start.toLocaleString(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
              return `• ${ev.title} — ${dateStr}`
            })
            const header = lang === 'he'
              ? `📅 האירועים הקרובים בלוח השנה שלך (7 ימים):`
              : `📅 Your upcoming calendar events (next 7 days):`
            calendarPreview = `\n\n${header}\n${lines.join('\n')}`
          }
        } catch {
          // non-fatal — skip preview if calendar read fails
        }

        await sendMessage(
          {
            toNumber: managerIdentity.phoneNumber,
            body: `${t('ob_calendar_connected', lang)}${calendarPreview}\n\n${getPrompt('customer_import', lang)}`,
          },
          waCredentials,
        ).catch((err) => app.log.warn({ err }, 'Failed to send calendar confirmation to manager'))
      }

      app.log.info({ businessId }, 'Google OAuth completed — refresh token stored')
      return reply.redirect('/oauth-success')
    },
  )
}
