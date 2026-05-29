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

// Embedded Signup widget page. Runs Meta's WhatsApp Embedded Signup via the Facebook
// JS SDK (FB.login with config_id). The number selection / QR-coexistence step happens
// inside Meta's wizard; the resulting phone_number_id + waba_id come back via the
// WA_EMBEDDED_SIGNUP message event, and the auth code via the FB.login callback. Both are
// POSTed to /oauth/meta/exchange. `esConfig` is a pre-serialised, <-escaped JSON literal.
const embeddedSignupHtml = (esConfig: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect WhatsApp</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 24px; text-align: center; color: #111; }
    button { background: #1877f2; color: #fff; border: 0; border-radius: 8px; padding: 14px 24px; font-size: 1rem; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    #status { margin-top: 20px; color: #555; min-height: 24px; }
    .err { color: #c00; }
  </style>
</head>
<body>
  <div style="font-size:3rem">💬</div>
  <h1>Connect your WhatsApp number</h1>
  <p style="color:#555">Tap the button and follow Meta's steps to link your number.</p>
  <button id="start">Connect WhatsApp</button>
  <div id="status"></div>
  <script>window.__ES = ${esConfig};</script>
  <script>
    var ES = window.__ES || {};
    var captured = { phone_number_id: null, waba_id: null };
    var statusEl = document.getElementById('status');
    function setStatus(msg, isErr) { statusEl.textContent = msg; statusEl.className = isErr ? 'err' : ''; }

    window.fbAsyncInit = function () {
      FB.init({ appId: ES.appId, autoLogAppEvents: true, xfbml: false, version: 'v21.0' });
    };
    (function (d, s, id) {
      var js, fjs = d.getElementsByTagName(s)[0];
      if (d.getElementById(id)) return;
      js = d.createElement(s); js.id = id;
      js.src = 'https://connect.facebook.net/en_US/sdk.js';
      fjs.parentNode.insertBefore(js, fjs);
    }(document, 'script', 'facebook-jssdk'));

    window.addEventListener('message', function (event) {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;
      try {
        var data = JSON.parse(event.data);
        if (data.type === 'WA_EMBEDDED_SIGNUP' && data.data) {
          if (data.data.phone_number_id) captured.phone_number_id = data.data.phone_number_id;
          if (data.data.waba_id) captured.waba_id = data.data.waba_id;
        }
      } catch (e) { /* non-JSON postMessage, ignore */ }
    });

    function finish(code) {
      setStatus('Finishing setup…');
      fetch('/oauth/meta/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, phone_number_id: captured.phone_number_id, waba_id: captured.waba_id, state: ES.state })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (res && res.ok) { window.location = '/oauth-success'; }
        else { setStatus('Setup failed: ' + ((res && res.error) || 'unknown error') + '. Please return to WhatsApp and try again.', true); }
      }).catch(function () {
        setStatus('Network error finishing setup. Please return to WhatsApp and try again.', true);
      });
    }

    document.getElementById('start').addEventListener('click', function () {
      if (!window.FB) { setStatus('Still loading — please wait a moment and tap again.', true); return; }
      var btn = this;
      btn.disabled = true;
      setStatus('Opening Meta…');
      FB.login(function (response) {
        if (response.authResponse && response.authResponse.code) {
          finish(response.authResponse.code);
        } else {
          btn.disabled = false;
          setStatus('Connection cancelled or not completed. Tap to try again.', true);
        }
      }, {
        config_id: ES.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: 'whatsapp_embedded_signup', sessionInfoVersion: '3' }
      });
    });
  </script>
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

  // ── Meta Embedded Signup widget page ──────────────────────────────────────────
  // Serves the Facebook JS SDK Embedded Signup widget. The MiddleMan signup link points
  // here (not directly at facebook.com) so the WhatsApp onboarding wizard actually runs.
  app.get<{ Querystring: { state?: string } }>('/embedded-signup', async (request, reply) => {
    const state = request.query.state ?? ''
    const appId = process.env['META_APP_ID'] ?? ''
    const configId = process.env['META_EMBEDDED_SIGNUP_CONFIG_ID'] ?? ''
    // <-escaped so the JSON literal can't break out of the <script> context
    const esConfig = JSON.stringify({ appId, configId, state }).replace(/</g, '\\u003c')
    return reply.type('text/html').send(embeddedSignupHtml(esConfig))
  })

  // ── Meta Embedded Signup completion ───────────────────────────────────────────
  // Called by the widget page (above) once the user finishes Meta's wizard. Receives the
  // auth code plus the phone_number_id / waba_id from the WA_EMBEDDED_SIGNUP event,
  // exchanges the code, subscribes webhooks, registers the number, and provisions.
  app.post<{ Body: { code?: string; phone_number_id?: string; waba_id?: string; state?: string } }>(
    '/oauth/meta/exchange',
    async (request, reply) => {
      const { code, phone_number_id, waba_id, state } = request.body ?? {}

      if (!code || !state || !phone_number_id) {
        return reply.status(400).send({ ok: false, error: 'Missing code, state, or phone_number_id' })
      }

      // 1. Look up the onboarding session by the state token stored in collectedData
      const [session] = await db
        .select()
        .from(providerOnboardingSessions)
        .where(sql`${providerOnboardingSessions.collectedData}->>'_signupState' = ${state}`)
        .limit(1)

      if (!session || session.completedAt) {
        app.log.warn({ state }, 'Meta exchange: no matching onboarding session')
        return reply.status(400).send({ ok: false, error: 'Invalid or expired signup session' })
      }

      const collectedData = session.collectedData as Record<string, unknown>
      const lang: Lang = (collectedData['language'] as Lang | undefined) ?? 'he'

      const appId = process.env['META_APP_ID'] ?? ''
      const appSecret = process.env['META_APP_SECRET'] ?? ''
      const providerAccessToken = process.env['PROVIDER_WA_ACCESS_TOKEN'] ?? ''
      const providerPhoneNumberId = process.env['PROVIDER_WA_PHONE_NUMBER_ID'] ?? ''

      const sendError = (err: string) =>
        sendMessage(
          { toNumber: session.managerPhone, body: i18n.mm_embedded_signup_error[lang](err) },
          { accessToken: providerAccessToken, phoneNumberId: providerPhoneNumberId },
        ).catch(() => {})

      try {
        // 2. Exchange the JS-SDK code for a token. Codes from FB.login are exchanged
        // WITHOUT redirect_uri (unlike the server-side redirect dialog).
        const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`
        const tokenRes = await fetch(tokenUrl)
        const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: { message?: string } }

        if (!tokenRes.ok || !tokenJson.access_token) {
          const err = tokenJson.error?.message ?? `HTTP ${tokenRes.status}`
          app.log.error({ err }, 'Meta token exchange failed')
          await sendError(err)
          return reply.status(502).send({ ok: false, error: err })
        }

        // 3. Exchange for a long-lived token (~60 days)
        const longLivedUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenJson.access_token}`
        const longLivedRes = await fetch(longLivedUrl)
        const longLivedJson = (await longLivedRes.json()) as { access_token?: string; error?: { message?: string } }
        const accessToken = longLivedJson.access_token ?? tokenJson.access_token

        // 4. Resolve the display number from the phone_number_id the widget returned
        const phoneRes = await fetch(
          `https://graph.facebook.com/v21.0/${phone_number_id}?fields=display_phone_number`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        const phoneJson = (await phoneRes.json()) as {
          display_phone_number?: string
          error?: { message?: string }
        }
        app.log.info({ phone_number_id, phoneJson }, 'Meta phone number lookup')

        if (!phoneJson.display_phone_number) {
          const err = phoneJson.error?.message ?? 'display_phone_number missing'
          app.log.error({ phone_number_id, phoneJson }, 'Meta phone number fetch failed')
          await sendError(err)
          return reply.status(502).send({ ok: false, error: 'Could not retrieve phone number from Meta' })
        }
        const phoneNumberId = phone_number_id
        const paPhoneNumber = '+' + phoneJson.display_phone_number.replace(/\D/g, '')

        // 5. Subscribe our app to the WABA's webhooks (required for inbound messages).
        // Best-effort: an "already subscribed" response is fine.
        if (waba_id) {
          const subRes = await fetch(
            `https://graph.facebook.com/v21.0/${waba_id}/subscribed_apps`,
            { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } },
          )
          const subJson = (await subRes.json()) as { success?: boolean; error?: { message?: string } }
          if (!subRes.ok || subJson.error) {
            app.log.warn({ waba_id, subJson }, 'subscribed_apps non-success (continuing)')
          } else {
            app.log.info({ waba_id }, 'WABA subscribed to app webhooks')
          }
        }

        // 6. Register the number on the Cloud API. For coexistence Meta auto-registers,
        // so this is best-effort: "already registered" / coexistence errors are non-fatal.
        const pin = String(Math.floor(100000 + Math.random() * 900000))
        const regRes = await fetch(
          `https://graph.facebook.com/v21.0/${phoneNumberId}/register`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
          },
        )
        const regJson = (await regRes.json()) as { success?: boolean; error?: { message?: string } }
        if (!regRes.ok || regJson.error) {
          app.log.warn({ phoneNumberId, regJson }, 'phone register non-success (continuing — may already be registered / coexistence)')
        } else {
          app.log.info({ phoneNumberId }, 'phone number registered on Cloud API')
        }

        // 7. Provision the business
        const fullData = {
          ...collectedData,
          phoneNumberId,
          accessToken,
          paPhoneNumber,
        }

        const provisionResult = await provisionBusiness(db, session.managerPhone, fullData as Record<string, unknown> as Parameters<typeof provisionBusiness>[2])
        if (!provisionResult.ok) {
          app.log.error({ error: provisionResult.error }, 'Business provisioning failed after Meta exchange')
          await sendMessage(
            { toNumber: session.managerPhone, body: i18n.mm_setup_failed[lang](provisionResult.error) },
            { accessToken: providerAccessToken, phoneNumberId: providerPhoneNumberId },
          ).catch(() => {})
          return reply.status(500).send({ ok: false, error: provisionResult.error })
        }

        // 8. Mark session complete
        await db.update(providerOnboardingSessions)
          .set({ completedAt: new Date(), collectedData: fullData as Record<string, unknown>, updatedAt: new Date() })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))

        // 9. Send success message to manager via MiddleMan
        await sendMessage(
          { toNumber: session.managerPhone, body: i18n.mm_done[lang](paPhoneNumber) },
          { accessToken: providerAccessToken, phoneNumberId: providerPhoneNumberId },
        ).catch((err) => app.log.warn({ err }, 'Failed to send mm_done to manager'))

        // 10. Send BK opening prompt via the new PA credentials (best-effort)
        const businessName = collectedData['businessName'] as string | undefined
        const bkOpeningPrompt = lang === 'he'
          ? `לפני שהלקוחות מגיעים, בואנו נלמד על *${businessName}* כדי שאוכל לייצג אתכם הכי טוב.\n\nאיך היית מתאר/ת את *${businessName}*? מה הרגש שאתה/את רוצה שלקוחות יקבלו אחרי כל ביקור? מה מייחד אתכם?\n\n(ככל שתשתף/י יותר, כך אדבר טוב יותר בשמך)`
          : `Before customers arrive, let me get to know *${businessName}* so I can represent you well.\n\nHow would you describe *${businessName}*? What feeling do you want customers to walk away with? What makes you stand out?\n\n(The more detail you share, the better I'll speak in your voice)`

        await sendMessage(
          { toNumber: session.managerPhone, body: bkOpeningPrompt },
          { accessToken, phoneNumberId },
        ).catch(() => { /* BK setup kickoff is best-effort */ })

        // 11. Post-provisioning case-specific messages
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
        return reply.send({ ok: true })

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        app.log.error({ err }, 'Unexpected error in Meta exchange')
        await sendError(msg)
        return reply.status(500).send({ ok: false, error: msg })
      }
    },
  )

  // ── Legacy Meta redirect callback ─────────────────────────────────────────────
  // The JS-SDK widget captures the code client-side and posts to /oauth/meta/exchange,
  // so this server-side redirect endpoint is no longer part of the happy path. It only
  // fires if Meta performs a redirect (e.g. a stray non-JS flow); send the user back.
  app.get<{ Querystring: { state?: string; error?: string } }>(
    '/oauth/meta/callback',
    async (request, reply) => {
      const { state, error } = request.query
      if (error) app.log.warn({ error }, 'Meta redirect callback: login error')
      else app.log.warn({ state }, 'Meta redirect callback hit — expected JS-SDK flow')
      if (state) return reply.redirect(`/embedded-signup?state=${encodeURIComponent(state)}`)
      return reply.status(400).send('Please reopen the signup link from WhatsApp.')
    },
  )
}
