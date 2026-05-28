import type { FastifyInstance } from 'fastify'
import { google } from 'googleapis'
import { eq, and, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses, identities, providerOnboardingSessions } from '../db/schema.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { getPrompt } from '../domain/onboarding/steps.js'
import { t, i18n, type Lang } from '../domain/i18n/t.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import { provisionBusiness } from '../domain/flows/provider-onboarding.js'

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

  // ── Meta Embedded Signup callback ─────────────────────────────────────────────
  // Called by Meta after the business owner completes the Embedded Signup flow.
  // Exchanges the code for a long-lived token, retrieves the phone number, and
  // provisions the business automatically.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/oauth/meta/callback',
    async (request, reply) => {
      const { code, state, error } = request.query

      if (error) {
        app.log.warn({ error }, 'Meta Embedded Signup denied by user')
        return reply.status(400).send(`Meta login error: ${error}`)
      }

      if (!code || !state) {
        return reply.status(400).send('Missing code or state')
      }

      // 1. Look up the onboarding session by the state token stored in collectedData
      const [session] = await db
        .select()
        .from(providerOnboardingSessions)
        .where(sql`${providerOnboardingSessions.collectedData}->>'_signupState' = ${state}`)
        .limit(1)

      if (!session || session.completedAt) {
        app.log.warn({ state }, 'Meta OAuth callback: no matching onboarding session')
        return reply.status(400).send('Invalid or expired signup session')
      }

      const collectedData = session.collectedData as Record<string, unknown>
      const lang: Lang = (collectedData['language'] as Lang | undefined) ?? 'he'

      const appId = process.env['META_APP_ID'] ?? ''
      const appSecret = process.env['META_APP_SECRET'] ?? ''
      const publicBaseUrl = process.env['PUBLIC_BASE_URL'] ?? ''
      const redirectUri = `${publicBaseUrl}/oauth/meta/callback`
      const providerAccessToken = process.env['PROVIDER_WA_ACCESS_TOKEN'] ?? ''
      const providerPhoneNumberId = process.env['PROVIDER_WA_PHONE_NUMBER_ID'] ?? ''

      const sendError = (err: string) =>
        sendMessage(
          { toNumber: session.managerPhone, body: i18n.mm_embedded_signup_error[lang](err) },
          { accessToken: providerAccessToken, phoneNumberId: providerPhoneNumberId },
        ).catch(() => {})

      try {
        // 2. Exchange code for short-lived user access token
        const tokenUrl = `https://graph.facebook.com/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`
        const tokenRes = await fetch(tokenUrl)
        const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: { message?: string } }

        if (!tokenRes.ok || !tokenJson.access_token) {
          const err = tokenJson.error?.message ?? `HTTP ${tokenRes.status}`
          app.log.error({ err }, 'Meta token exchange failed')
          await sendError(err)
          return reply.status(502).send('Meta token exchange failed')
        }

        // 3. Exchange for long-lived token (~60 days)
        const longLivedUrl = `https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenJson.access_token}`
        const longLivedRes = await fetch(longLivedUrl)
        const longLivedJson = (await longLivedRes.json()) as { access_token?: string; error?: { message?: string } }
        const accessToken = longLivedJson.access_token ?? tokenJson.access_token

        // 4. Retrieve WhatsApp Business Accounts and phone numbers via business graph
        // /me/phone_numbers is for Facebook login codes — WABA phone numbers live under /businesses
        const wabaRes = await fetch(
          `https://graph.facebook.com/v21.0/me/businesses?fields=whatsapp_business_accounts{id,phone_numbers{id,display_phone_number}}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        const wabaJson = (await wabaRes.json()) as {
          data?: Array<{
            id: string
            whatsapp_business_accounts?: {
              data?: Array<{
                id: string
                phone_numbers?: { data?: Array<{ id: string; display_phone_number: string }> }
              }>
            }
          }>
          error?: { message?: string }
        }

        // Flatten: find the first available phone number across all WABAs
        let phoneNumberId: string | undefined
        let paPhoneNumber: string | undefined
        for (const biz of wabaJson.data ?? []) {
          for (const waba of biz.whatsapp_business_accounts?.data ?? []) {
            const phones = waba.phone_numbers?.data ?? []
            if (phones.length > 0) {
              phoneNumberId = phones[0]!.id
              paPhoneNumber = '+' + phones[0]!.display_phone_number.replace(/\D/g, '')
              break
            }
          }
          if (phoneNumberId) break
        }

        if (!phoneNumberId || !paPhoneNumber) {
          const err = wabaJson.error?.message ?? 'No WhatsApp phone numbers found for this account'
          app.log.error({ wabaJson }, 'Meta phone number fetch failed')
          await sendError(err)
          return reply.status(502).send('Could not retrieve phone number from Meta')
        }

        // 5. Provision the business
        const fullData = {
          ...collectedData,
          phoneNumberId,
          accessToken,
          paPhoneNumber,
        }

        const provisionResult = await provisionBusiness(db, session.managerPhone, fullData as Record<string, unknown> as Parameters<typeof provisionBusiness>[2])
        if (!provisionResult.ok) {
          app.log.error({ error: provisionResult.error }, 'Business provisioning failed after Meta OAuth')
          await sendMessage(
            { toNumber: session.managerPhone, body: i18n.mm_setup_failed[lang](provisionResult.error) },
            { accessToken: providerAccessToken, phoneNumberId: providerPhoneNumberId },
          ).catch(() => {})
          return reply.status(500).send('Provisioning failed')
        }

        // 6. Mark session complete
        await db.update(providerOnboardingSessions)
          .set({ completedAt: new Date(), collectedData: fullData as Record<string, unknown>, updatedAt: new Date() })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))

        // 7. Send success message to manager via MiddleMan
        await sendMessage(
          { toNumber: session.managerPhone, body: i18n.mm_done[lang](paPhoneNumber) },
          { accessToken: providerAccessToken, phoneNumberId: providerPhoneNumberId },
        ).catch((err) => app.log.warn({ err }, 'Failed to send mm_done to manager'))

        // 8. Send BK opening prompt via the new PA credentials (best-effort)
        const businessName = collectedData['businessName'] as string | undefined
        const bkOpeningPrompt = lang === 'he'
          ? `לפני שהלקוחות מגיעים, בואנו נלמד על *${businessName}* כדי שאוכל לייצג אתכם הכי טוב.\n\nאיך היית מתאר/ת את *${businessName}*? מה הרגש שאתה/את רוצה שלקוחות יקבלו אחרי כל ביקור? מה מייחד אתכם?\n\n(ככל שתשתף/י יותר, כך אדבר טוב יותר בשמך)`
          : `Before customers arrive, let me get to know *${businessName}* so I can represent you well.\n\nHow would you describe *${businessName}*? What feeling do you want customers to walk away with? What makes you stand out?\n\n(The more detail you share, the better I'll speak in your voice)`

        await sendMessage(
          { toNumber: session.managerPhone, body: bkOpeningPrompt },
          { accessToken, phoneNumberId },
        ).catch(() => { /* BK setup kickoff is best-effort */ })

        // 9. Post-provisioning case-specific messages
        const wabaCase = (collectedData['_wabaCase'] as string | undefined) ?? '1'

        if (wabaCase === '2') {
          // Coexistence case: 14-day reminder is already embedded in the link message.
          // No additional message needed — the reminder was sent with the signup link.
        } else {
          // Case 1 and 3a: send Business Suite info + coexistence nudge for Case 1
          const businessSuiteMsg = lang === 'he'
            ? i18n.mm_business_suite['he']
            : i18n.mm_business_suite['en']

          await sendMessage(
            { toNumber: session.managerPhone, body: businessSuiteMsg },
            { accessToken, phoneNumberId },
          ).catch(() => { /* best-effort */ })

          if (wabaCase === '1') {
            const nudgeMsg = lang === 'he'
              ? i18n.mm_case1_coexistence_nudge['he']
              : i18n.mm_case1_coexistence_nudge['en']

            await sendMessage(
              { toNumber: session.managerPhone, body: nudgeMsg },
              { accessToken: providerAccessToken, phoneNumberId: providerPhoneNumberId },
            ).catch(() => { /* best-effort */ })
          }
        }

        app.log.info({ managerPhone: session.managerPhone, paPhoneNumber }, 'Meta Embedded Signup completed — business provisioned')
        return reply.redirect('/oauth-success')

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        app.log.error({ err }, 'Unexpected error in Meta OAuth callback')
        await sendError(msg)
        return reply.status(500).send('Internal error during Meta OAuth')
      }
    },
  )
}
