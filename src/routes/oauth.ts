import type { FastifyInstance } from 'fastify'
import { google } from 'googleapis'
import { eq, and, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses, identities } from '../db/schema.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { ONBOARDING_PROMPTS } from '../domain/onboarding/steps.js'

function buildOAuth2Client() {
  return new google.auth.OAuth2(
    process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_CLIENT_SECRET'],
    process.env['GOOGLE_REDIRECT_URI'],
  )
}

const SCOPES = ['https://www.googleapis.com/auth/calendar']

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
      scope: SCOPES,
      prompt: 'consent',
      state: businessId,
    })

    return reply.redirect(url)
  })

  // Step 2 — Google redirects back here with auth code
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/oauth/google/callback',
    async (request, reply) => {
      const { code, state: businessId, error } = request.query

      if (error) {
        app.log.warn({ error }, 'Google OAuth denied')
        return reply.status(400).send(`Google OAuth error: ${error}`)
      }

      if (!code || !businessId) {
        return reply.status(400).send('Missing code or state')
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
      const { tokens } = await auth.getToken(code)

      if (!tokens.refresh_token) {
        return reply
          .status(400)
          .send('Google did not return a refresh token. Re-authorize with prompt=consent.')
      }

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
        const waCredentials = updatedBusiness.whatsappPhoneNumberId && updatedBusiness.whatsappAccessToken
          ? { accessToken: updatedBusiness.whatsappAccessToken, phoneNumberId: updatedBusiness.whatsappPhoneNumberId }
          : undefined

        await sendMessage(
          {
            toNumber: managerIdentity.phoneNumber,
            body: `✅ Google Calendar connected!\n\n${ONBOARDING_PROMPTS.customer_import.prompt}`,
          },
          waCredentials,
        ).catch((err) => app.log.warn({ err }, 'Failed to send calendar confirmation to manager'))
      }

      app.log.info({ businessId }, 'Google OAuth completed — refresh token stored')
      return reply.redirect('/oauth-success')
    },
  )
}
