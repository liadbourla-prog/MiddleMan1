import type { FastifyInstance } from 'fastify'
import { google } from 'googleapis'
import type { Credentials } from 'google-auth-library'
import { eq, and, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses, identities, providerOnboardingSessions } from '../db/schema.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { getPrompt } from '../domain/onboarding/steps.js'
import { t, i18n, type Lang } from '../domain/i18n/t.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import { useNativeFetch } from '../adapters/google/native-fetch.js'
import { generateOnboardingReply } from '../adapters/llm/client.js'
import { provisionBusiness } from '../domain/flows/provider-onboarding.js'
import { registerWatchChannel } from '../domain/calendar/inbound-sync.js'
import { logAudit } from '../domain/audit/logger.js'
import { chooseCalendarId, isPlausibleCalendarId, type CalendarListEntry } from '../domain/calendar/calendar-id.js'

function buildOAuth2Client() {
  return useNativeFetch(new google.auth.OAuth2(
    process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_CLIENT_SECRET'],
    process.env['GOOGLE_REDIRECT_URI'],
  ))
}

// The server→Google token exchange occasionally drops mid-response on Cloud Run
// (ERR_STREAM_PREMATURE_CLOSE / "Premature close" from the undici transport). A failed
// calendar connection is unacceptable at launch, so retry transient failures with a short
// backoff. `invalid_grant` means the auth code was already consumed/expired — retrying
// cannot help, so bail immediately and let the caller ask the owner to reconnect.
type GoogleTokens = Credentials

async function exchangeCodeForTokens(
  auth: ReturnType<typeof buildOAuth2Client>,
  code: string,
  log: FastifyInstance['log'],
): Promise<GoogleTokens> {
  const MAX_ATTEMPTS = 3
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { tokens } = await auth.getToken(code)
      return tokens
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (/invalid_grant/i.test(msg)) throw err // consumed/expired code — retry is futile
      log.warn({ attempt, err: msg }, '[oauth] token exchange failed; retrying')
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempt))
    }
  }
  throw lastErr
}

const OAUTH_RETRY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connection hiccup</title>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; color: #111; }</style>
</head>
<body>
  <div style="font-size:3rem">🔄</div>
  <h1>Almost there — let's try once more</h1>
  <p style="color:#555">The connection to Google hit a brief hiccup. Please return to WhatsApp and tap the calendar-connect link again — it usually goes through on the next try.</p>
</body>
</html>`

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

    // Client-side telemetry beacon. Browser console logs never reach the server, so we
    // POST key milestones (SDK init, every postMessage origin/type, FB.login result) to
    // /oauth/meta/debug. This is how we tell "WA wizard never launched" (no
    // WA_EMBEDDED_SIGNUP event at all) apart from "event fired but we dropped it"
    // (wrong origin). Best-effort, never blocks the flow.
    function beacon(event, detail) {
      try {
        fetch('/oauth/meta/debug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: ES.state, event: event, detail: detail, ua: navigator.userAgent })
        }).catch(function () {});
      } catch (e) { /* ignore */ }
    }
    beacon('page_loaded', { featureType: ES.featureType || '(none)', hasConfigId: Boolean(ES.configId), href: location.href });

    window.fbAsyncInit = function () {
      FB.init({ appId: ES.appId, autoLogAppEvents: true, xfbml: false, version: 'v21.0' });
      beacon('fb_init', {});
    };
    (function (d, s, id) {
      var js, fjs = d.getElementsByTagName(s)[0];
      if (d.getElementById(id)) return;
      js = d.createElement(s); js.id = id;
      js.src = 'https://connect.facebook.net/en_US/sdk.js';
      fjs.parentNode.insertBefore(js, fjs);
    }(document, 'script', 'facebook-jssdk'));

    window.addEventListener('message', function (event) {
      // Match any facebook.com subdomain (www, web, business, regional locales). An exact
      // www-only match silently drops WA_EMBEDDED_SIGNUP events posted from other FB origins.
      var origin = String(event.origin || '');
      var isFb = origin.indexOf('facebook.com') !== -1;
      var parsedType = null;
      try {
        var data = JSON.parse(event.data);
        parsedType = data && data.type;
        if (isFb && data.type === 'WA_EMBEDDED_SIGNUP' && data.data) {
          if (data.data.phone_number_id) captured.phone_number_id = data.data.phone_number_id;
          if (data.data.waba_id) captured.waba_id = data.data.waba_id;
          beacon('wa_embedded_signup', { origin: origin, eventName: data.data.event, hasPhone: Boolean(data.data.phone_number_id), hasWaba: Boolean(data.data.waba_id) });
        }
      } catch (e) { /* non-JSON postMessage (e.g. SDK noise), ignore for capture */ }
      // Log every inbound message's origin + parsed type so we can see whether the WA
      // wizard is posting anything at all, and from where.
      beacon('postmessage', { origin: origin, isFb: isFb, type: parsedType });
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
      // Build extras. featureType is only included for coexistence
      // ('whatsapp_business_app_onboarding'); omitting it runs standard Embedded Signup.
      // An invalid/unknown featureType makes Meta fall back to a plain Login-for-Business
      // reconnect and never launch the WhatsApp wizard.
      var extras = { setup: {}, sessionInfoVersion: '3' };
      if (ES.featureType) extras.featureType = ES.featureType;
      FB.login(function (response) {
        var hasCode = Boolean(response && response.authResponse && response.authResponse.code);
        beacon('fb_login_callback', {
          status: response && response.status,
          hasAuthResponse: Boolean(response && response.authResponse),
          hasCode: hasCode,
          hadPhone: Boolean(captured.phone_number_id),
          hadWaba: Boolean(captured.waba_id)
        });
        if (hasCode) {
          finish(response.authResponse.code);
        } else {
          btn.disabled = false;
          setStatus('Connection cancelled or not completed. Tap to try again.', true);
        }
      }, {
        config_id: ES.configId,
        response_type: 'code',
        override_default_response_type: true,
        scope: 'whatsapp_business_management,whatsapp_business_messaging',
        extras: extras
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
        .select({ id: businesses.id, googleCalendarId: businesses.googleCalendarId })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1)

      if (!business) {
        return reply.status(404).send('Business not found')
      }

      const auth = buildOAuth2Client()
      let tokens: GoogleTokens
      try {
        tokens = await exchangeCodeForTokens(auth, code, app.log)
      } catch (err) {
        // Transient drops are retried inside the helper; reaching here means it still
        // failed (or the code was already consumed). Show a friendly retry page rather
        // than a raw 500 — the owner just taps the connect link again.
        app.log.error({ err: err instanceof Error ? err.message : String(err) }, '[oauth] token exchange failed after retries')
        return reply.status(503).type('text/html').send(OAUTH_RETRY_HTML)
      }

      if (!tokens.refresh_token) {
        return reply
          .status(400)
          .send('Google did not return a refresh token. Re-authorize with prompt=consent.')
      }

      // Store the token AND switch the business into google calendar mode. Without
      // the mode flip, createCalendarClient keeps returning the internal client and
      // the freshly-connected calendar is never read or written — so a business that
      // onboarded in internal mode and connects Google later would stay effectively
      // unsynced. Connecting Google is an explicit choice to use it.
      await db
        .update(businesses)
        .set({ googleRefreshToken: tokens.refresh_token, calendarMode: 'google' })
        .where(eq(businesses.id, businessId))

      // Resolve a VALID googleCalendarId from the connected account (F-b). The column
      // was historically seeded with a phone-number placeholder by onboarding, which
      // made every Google write 404. Fetch the account's calendars and pick a real
      // write target: preserve a still-valid prior selection (e.g. a secondary
      // calendar), else the primary, else the literal 'primary'. The owner can switch
      // later from WhatsApp ("use my Testing calendar").
      let switchCandidates: CalendarListEntry[] = []
      try {
        const listClient = createCalendarClient({
          accessToken: tokens.access_token ?? '',
          refreshToken: tokens.refresh_token,
          calendarId: 'primary',
          calendarMode: 'google',
        })
        const calendars = await listClient.listCalendars()
        const chosen = chooseCalendarId(calendars, business.googleCalendarId)
        switchCandidates = chosen.candidates
        await db.update(businesses).set({ googleCalendarId: chosen.calendarId }).where(eq(businesses.id, businessId))
        app.log.info({ businessId, calendarId: chosen.calendarId, source: chosen.source }, '[oauth] resolved googleCalendarId')
      } catch (err) {
        // calendarList read failed — never leave a non-calendar value in the column.
        // Keep a plausible prior selection, otherwise fall back to 'primary'.
        const safeId = isPlausibleCalendarId(business.googleCalendarId) ? business.googleCalendarId : 'primary'
        if (safeId !== business.googleCalendarId) {
          await db.update(businesses).set({ googleCalendarId: safeId }).where(eq(businesses.id, businessId))
        }
        app.log.warn({ businessId, err: err instanceof Error ? err.message : String(err), safeId }, '[oauth] calendarList read failed; used safe calendar id')
      }

      // Action ledger (L1 grounding): record the real connect so the PA can never
      // falsely claim the calendar is/ isn't connected.
      await logAudit(db, {
        businessId,
        actorId: null,
        action: 'calendar.connected',
        entityType: 'business',
        entityId: businessId,
        metadata: { provider: 'google' },
      }).catch(() => { /* best-effort */ })

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
        // Capture the narrowed values so the async closure below keeps non-null types.
        // (refresh_token was narrowed to string by the guard above, but TS drops
        // that property-narrowing inside the nested closure — re-pin it here.)
        const mgr = managerIdentity
        const biz = updatedBusiness
        const refreshToken = tokens.refresh_token
        // Notify the manager out-of-band: the calendar preview read, the voiced
        // prompt (an LLM call), and the WhatsApp send all happen AFTER we redirect,
        // so the OAuth browser redirect returns immediately instead of blocking on
        // these network round-trips.
        void (async () => {
          const lang: Lang = (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
          const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
            ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
            : undefined

          // Fetch next 7 days of calendar events as a preview
          let calendarPreview = ''
          try {
            const calClient = createCalendarClient({
              accessToken: tokens.access_token ?? '',
              refreshToken,
              calendarId: biz.googleCalendarId,
              calendarMode: 'google',
            })
            const now = new Date()
            const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60_000)
            const events = await calClient.listEvents(now, weekAhead)
            if (events.length > 0) {
              const locale = lang === 'he' ? 'he-IL' : 'en-GB'
              const tz = biz.timezone ?? 'UTC'
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

          // When the account has more than one writable calendar, tell the owner which
          // one the PA will use and that they can switch from chat (F-b). With a single
          // calendar there is nothing to choose, so stay quiet.
          let calendarChoiceNote = ''
          if (switchCandidates.length > 1) {
            const active = switchCandidates.find((c) => c.id === biz.googleCalendarId)
            const others = switchCandidates.filter((c) => c.id !== biz.googleCalendarId).map((c) => c.summary)
            const activeName = active?.summary ?? (biz.googleCalendarId === 'primary' ? (lang === 'he' ? 'הראשי' : 'your main calendar') : biz.googleCalendarId)
            calendarChoiceNote = lang === 'he'
              ? `\n\nאני אנהל את היומן: *${activeName}*. אם תעדיף יומן אחר (${others.join(', ')}) — פשוט תכתוב לי "תשתמש ביומן <שם>".`
              : `\n\nI'll manage the *${activeName}* calendar. Prefer a different one (${others.join(', ')})? Just tell me "use the <name> calendar".`
          }

          // The connection happened via a Google button, not a manager message, so
          // there is no reply to acknowledge — the ob_calendar_connected line below
          // already confirms it. Tell the LLM to just ask the import question.
          const importQ = await generateOnboardingReply({
            step: 'customer_import',
            businessName: biz.name,
            lang,
            isRetry: false,
            extraContext: lang === 'he'
              ? 'המנהל הרגע חיבר את לוח השנה. ההודעה שלפניך כבר אישרה זאת — אל תאשר שוב, פשוט שאל אם יש רשימת לקוחות, היסטוריית תורים או קטלוג שירותים לייבא.'
              : 'The manager just connected their calendar. The preceding line already confirms it — do not acknowledge it again; simply ask whether they have a customer list, booking history, or service catalog to import.',
          })
          await sendMessage(
            {
              toNumber: mgr.phoneNumber,
              body: `${t('ob_calendar_connected', lang)}${calendarPreview}${calendarChoiceNote}\n\n${importQ || getPrompt('customer_import', lang)}`,
            },
            waCredentials,
          ).catch((err) => app.log.warn({ err }, 'Failed to send calendar confirmation to manager'))
        })().catch((err) => app.log.warn({ err }, 'Calendar-connected manager notification failed'))
      }

      // Inbound sync (Phase 3): open a Google push channel for this business so
      // owner-originated calendar edits flow back into the internal record.
      // No-op unless ops has enabled the feature + provisioned the callback.
      void registerWatchChannel(businessId).catch((err: unknown) => {
        app.log.warn({ err, businessId }, 'Calendar watch-channel registration failed (non-fatal)')
      })

      app.log.info({ businessId }, 'Google OAuth completed — refresh token stored')
      return reply.redirect('/oauth-success')
    },
  )

  // ── Meta Embedded Signup widget page ──────────────────────────────────────────
  // Serves the Facebook JS SDK Embedded Signup widget. The MiddleMan signup link points
  // here (not directly at facebook.com) so the WhatsApp onboarding wizard actually runs.
  app.get<{ Querystring: { state?: string; ft?: string } }>('/embedded-signup', async (request, reply) => {
    const state = request.query.state ?? ''
    // featureType selects the Meta wizard variant. 'whatsapp_business_app_onboarding' runs
    // the coexistence flow (QR-link an existing WA Business App number); empty runs standard
    // Embedded Signup. Allowlist the value so a crafted query can't inject arbitrary input.
    const ft = request.query.ft === 'whatsapp_business_app_onboarding' ? request.query.ft : ''
    const appId = process.env['META_APP_ID'] ?? ''
    const configId = process.env['META_EMBEDDED_SIGNUP_CONFIG_ID'] ?? ''
    // <-escaped so the JSON literal can't break out of the <script> context
    const esConfig = JSON.stringify({ appId, configId, state, featureType: ft }).replace(/</g, '\\u003c')
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

      // phone_number_id / waba_id come from the WA_EMBEDDED_SIGNUP widget event. On a
      // Facebook "reconnect" (returning user re-granting an existing connection) that event
      // may not fire, so they can be absent here — we resolve them from the granted token
      // below. Only code + state are strictly required at this point.
      if (!code || !state) {
        return reply.status(400).send({ ok: false, error: 'Missing code or state' })
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
        // 2. Exchange the JS-SDK code for a token. The redirect_uri sent here must be
        // IDENTICAL to the one the FB JS SDK bound the code to in the OAuth dialog.
        //   - Desktop (popup): the SDK uses Facebook's internal receiver → exchange with NO
        //     redirect_uri (the documented Embedded Signup path).
        //   - Mobile / in-app browser (popups suppressed): the SDK falls back to a redirect
        //     using one of the app's allowlisted "Valid OAuth Redirect URIs". Under Strict
        //     Mode that must be an exact match — the origin-with-trailing-slash entry — so the
        //     code is bound to `${PUBLIC_BASE_URL}/` and the exchange must repeat it.
        // We can't tell which path the client took, so try each candidate until one validates.
        const publicBaseUrl = (process.env['PUBLIC_BASE_URL'] ?? '').replace(/\/+$/, '')
        type FbErr = {
          message?: string
          code?: number
          error_subcode?: number
          type?: string
          fbtrace_id?: string
        }
        type TokenResp = { access_token?: string; error?: FbErr }
        // Try candidate redirect_uris in order. `undefined` = omit redirect_uri (the documented
        // SDK path). Meta's "redirect_uri" error text is generic — it masks the real cause — so
        // we capture the FULL error object (code/subcode/type/fbtrace_id) for the FIRST attempt,
        // which is the clean one before the code could be consumed by a retry.
        const redirectCandidates: { label: string; uri: string | undefined }[] = [
          { label: '(none)', uri: undefined },
          { label: 'origin/', uri: publicBaseUrl ? `${publicBaseUrl}/` : undefined },
          { label: 'origin', uri: publicBaseUrl || undefined },
          { label: 'page', uri: publicBaseUrl ? `${publicBaseUrl}/embedded-signup` : undefined },
          { label: 'cb', uri: publicBaseUrl ? `${publicBaseUrl}/oauth/meta/callback` : undefined },
        ]
        let tokenJson: TokenResp = {}
        let tokenOk = false
        let lastErr = ''
        let firstErr: FbErr | undefined
        for (const cand of redirectCandidates) {
          let tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`
          if (cand.uri) tokenUrl += `&redirect_uri=${encodeURIComponent(cand.uri)}`
          const tokenRes = await fetch(tokenUrl)
          tokenJson = (await tokenRes.json()) as TokenResp
          if (tokenRes.ok && tokenJson.access_token) {
            tokenOk = true
            app.log.info({ redirectUri: cand.label }, 'Meta token exchange succeeded')
            break
          }
          const e = tokenJson.error ?? {}
          if (!firstErr) firstErr = e
          lastErr = e.message ?? `HTTP ${tokenRes.status}`
          app.log.warn(
            {
              candidate: cand.label,
              code: e.code,
              subcode: e.error_subcode,
              type: e.type,
              fbtrace_id: e.fbtrace_id,
              msg: e.message,
            },
            'Meta token exchange candidate failed',
          )
          // A used/expired code won't be fixed by a different redirect_uri — stop retrying.
          if (/expired|been used|already been/i.test(lastErr)) break
        }

        if (!tokenOk || !tokenJson.access_token) {
          app.log.error(
            {
              err: lastErr,
              firstCode: firstErr?.code,
              firstSubcode: firstErr?.error_subcode,
              firstType: firstErr?.type,
              firstTrace: firstErr?.fbtrace_id,
              hadPhoneFromWidget: Boolean(phone_number_id),
              hadWabaFromWidget: Boolean(waba_id),
            },
            'Meta token exchange failed (all redirect_uri candidates)',
          )
          await sendError(lastErr)
          return reply.status(502).send({ ok: false, error: lastErr })
        }

        // 3. Exchange for a long-lived token (~60 days)
        const longLivedUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenJson.access_token}`
        const longLivedRes = await fetch(longLivedUrl)
        const longLivedJson = (await longLivedRes.json()) as { access_token?: string; error?: { message?: string } }
        const accessToken = longLivedJson.access_token ?? tokenJson.access_token

        // 3b. Resolve phone_number_id / waba_id. The widget event is the primary source, but
        // on a reconnect it may not fire — fall back to the token's granted WhatsApp assets:
        // debug_token → granular_scopes (whatsapp_business_management target_ids = WABA IDs)
        // → GET /{waba_id}/phone_numbers → phone_number_id.
        let resolvedPhoneNumberId = phone_number_id
        let resolvedWabaId = waba_id
        if (!resolvedPhoneNumberId) {
          try {
            const dbgRes = await fetch(
              `https://graph.facebook.com/v21.0/debug_token?input_token=${accessToken}&access_token=${appId}|${appSecret}`,
            )
            const dbgJson = (await dbgRes.json()) as {
              data?: { granular_scopes?: { scope: string; target_ids?: string[] }[] }
            }
            const scopes = dbgJson.data?.granular_scopes ?? []
            const waScope =
              scopes.find((s) => s.scope === 'whatsapp_business_management') ??
              scopes.find((s) => s.scope === 'whatsapp_business_messaging')
            const wabaIds = waScope?.target_ids ?? []
            app.log.info({ wabaIds }, 'Meta exchange: resolving WABA from token (widget event absent)')
            for (const wid of wabaIds) {
              const pnRes = await fetch(
                `https://graph.facebook.com/v21.0/${wid}/phone_numbers?fields=id,display_phone_number`,
                { headers: { Authorization: `Bearer ${accessToken}` } },
              )
              const pnJson = (await pnRes.json()) as {
                data?: { id?: string; display_phone_number?: string }[]
              }
              const first = pnJson.data?.[0]
              if (first?.id) {
                resolvedPhoneNumberId = first.id
                resolvedWabaId = wid
                break
              }
            }
          } catch (e) {
            app.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'WABA resolution from token failed')
          }
        }

        if (!resolvedPhoneNumberId) {
          // No number came back from the widget and none is attached to the granted token.
          // This is the "reconnect with nothing to onboard" dead-end: the user re-granted an
          // existing Facebook connection that has no linked WhatsApp number. They must remove
          // the existing connection and run onboarding fresh so the QR / number step appears.
          app.log.warn({ state }, 'Meta exchange: no phone_number_id from widget and no WABA on token')
          const noNumberMsg = i18n.mm_no_number_linked[lang]
          await sendMessage(
            { toNumber: session.managerPhone, body: noNumberMsg },
            { accessToken: providerAccessToken, phoneNumberId: providerPhoneNumberId },
          ).catch(() => {})
          return reply.status(422).send({ ok: false, error: noNumberMsg })
        }

        // 4. Resolve the display number from the resolved phone_number_id
        const phoneRes = await fetch(
          `https://graph.facebook.com/v21.0/${resolvedPhoneNumberId}?fields=display_phone_number`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        const phoneJson = (await phoneRes.json()) as {
          display_phone_number?: string
          error?: { message?: string }
        }
        app.log.info({ phoneNumberId: resolvedPhoneNumberId, phoneJson }, 'Meta phone number lookup')

        if (!phoneJson.display_phone_number) {
          const err = phoneJson.error?.message ?? 'display_phone_number missing'
          app.log.error({ phoneNumberId: resolvedPhoneNumberId, phoneJson }, 'Meta phone number fetch failed')
          await sendError(err)
          return reply.status(502).send({ ok: false, error: 'Could not retrieve phone number from Meta' })
        }
        const phoneNumberId = resolvedPhoneNumberId
        const paPhoneNumber = '+' + phoneJson.display_phone_number.replace(/\D/g, '')

        // 5. Subscribe our app to the WABA's webhooks (required for inbound messages).
        // Best-effort: an "already subscribed" response is fine.
        if (resolvedWabaId) {
          const subRes = await fetch(
            `https://graph.facebook.com/v21.0/${resolvedWabaId}/subscribed_apps`,
            { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } },
          )
          const subJson = (await subRes.json()) as { success?: boolean; error?: { message?: string } }
          if (!subRes.ok || subJson.error) {
            app.log.warn({ wabaId: resolvedWabaId, subJson }, 'subscribed_apps non-success (continuing)')
          } else {
            app.log.info({ wabaId: resolvedWabaId }, 'WABA subscribed to app webhooks')
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
          // Capture the WABA id so per-WABA template provisioning can fire (it was previously
          // never persisted, leaving provisioning a no-op with skippedReason 'no_waba').
          ...(resolvedWabaId ? { whatsappBusinessAccountId: resolvedWabaId } : {}),
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
          ? `לפני שהלקוחות מגיעים, בואנו נלמד על *${businessName}* כדי שאוכל לייצג אתכם הכי טוב.\n\nאיך היית מתאר את *${businessName}*? מה הרגש שאתה רוצה שלקוחות יקבלו אחרי כל ביקור? מה מייחד אתכם?\n\n(ככל שתשתף יותר, כך אדבר טוב יותר בשמך)`
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

  // ── Meta Embedded Signup client telemetry ─────────────────────────────────────
  // The widget page POSTs milestones here (page_loaded, fb_init, every postMessage
  // origin/type, wa_embedded_signup, fb_login_callback) so we can diagnose the flow from
  // Cloud Run logs. Browser console isn't visible server-side; this is our only window
  // into whether the WhatsApp wizard launches and what it posts back. No side effects.
  app.post<{ Body: { state?: string; event?: string; detail?: unknown; ua?: string } }>(
    '/oauth/meta/debug',
    async (request, reply) => {
      const { state, event, detail, ua } = request.body ?? {}
      app.log.info({ state, esEvent: event, detail, ua }, 'Embedded Signup client telemetry')
      return reply.send({ ok: true })
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
