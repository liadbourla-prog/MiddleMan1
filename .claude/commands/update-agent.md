# Update Agent

Deploys the MiddleMan project to production. Execute only when the user explicitly asks to deploy or update.

## Project context
- **Repo**: https://github.com/liadbourla-prog/MiddleMan1 (username: `liadbourla-prog`)
- **Cloud Run service**: pa-backend (europe-west3, project: deepr-490316)
- **Live URL**: https://pa-backend-d5jzekc5da-ey.a.run.app
- **Deploy script**: `./deploy.sh` in project root
- **Pipeline**: push to main → Cloud Build (migrate → build → push → Cloud Run deploy)
- **Cloud Build trigger ID**: `11e3eba3-8602-4b3b-86b0-c17b37afb7d4`

## Arguments: $ARGUMENTS

Parse the arguments to determine the deploy scope. If no arguments, do a full deploy.

---

## ⚠️ Pre-deploy checklist (run before every full deploy)

### 1. Check GitHub auth
```bash
git ls-remote origin HEAD 2>&1 | head -3
```
If this fails, git push will fail. The remote uses HTTPS — push requires a GitHub Personal Access Token (NOT the GitHub password, which is rejected). When git prompts for credentials: Username = `liadbourla-prog`, Password = the PAT. Inform the user upfront if auth will be needed.

### 2. Check provider WA token expiry
```bash
PHONE_ID=$(gcloud secrets versions access latest --secret=provider-wa-phone-number-id --project=deepr-490316 2>/dev/null)
TOKEN=$(gcloud secrets versions access latest --secret=provider-wa-access-token --project=deepr-490316 2>/dev/null)
curl -s "https://graph.facebook.com/v21.0/$PHONE_ID?fields=display_phone_number,status&access_token=$TOKEN" | python3 -m json.tool
```
If the response contains `"Session has expired"` or any error, ask the user to go to **Meta Developer Portal → WhatsApp → API Setup** and paste the new temporary access token. Then update it:
```bash
printf '%s' 'NEW_TOKEN' | gcloud secrets versions add provider-wa-access-token --data-file=- --project=deepr-490316
```

---

## Scope options

### Full deploy (default — no args or "full")
1. Run pre-deploy checklist above
2. Run `./deploy.sh --watch` from the project root — this commits all changes, auto-increments version tag (e.g. v1.0.0 → v1.0.1), pushes to GitHub, and streams Cloud Build logs
   - **If `./deploy.sh` fails at git push** (auth error): the commit and tag were already created locally. Do NOT re-run the script. Instead, ask the user to run `git push origin main --tags` from their terminal (requires GitHub PAT as password). Cloud Build triggers on push.
3. After build succeeds: **verify migrations actually applied** (see Migration verification below)
4. Run post-deploy checks

### Code only ("code", "code-only")
Same as full deploy — migrations are idempotent, safe to re-run.

### Secrets update ("secrets", "token", "refresh")
Update one or more secrets in GCP Secret Manager, then force a new Cloud Run revision:
1. Identify which secret to update from the argument (e.g. "refresh WA token", "update app secret")
2. Use `printf '%s' 'VALUE' | gcloud secrets versions add SECRET_NAME --data-file=- --project=deepr-490316`
3. Force Cloud Run to pick it up: `gcloud run services update pa-backend --region=europe-west3 --project=deepr-490316 --update-secrets=ENV_VAR=secret-name:latest`

Secret name mapping:
| What the user says | Secret name | Cloud Run env var |
|---|---|---|
| WA access token / WhatsApp token | wa-access-token | WHATSAPP_ACCESS_TOKEN |
| WA app secret | wa-app-secret | WHATSAPP_APP_SECRET |
| Provider WA token / MiddleMan token | provider-wa-access-token | PROVIDER_WA_ACCESS_TOKEN |
| Google client secret | GOOGLE_CLIENT_SECRET | GOOGLE_CLIENT_SECRET |
| Database URL | DATABASE_URL | DATABASE_URL |
| Redis URL | REDIS_URL | REDIS_URL |

### Provision new business ("provision", "new business", "add business")
Add a new business to the system without redeploying code:
1. Start Cloud SQL proxy locally: `./cloud-sql-proxy deepr-490316:europe-west3:deepr-project --port 5433 &`
2. Run: `DATABASE_URL="postgres://pa_user:150404@127.0.0.1:5433/pa4business" PROVISION_WA_NUMBER="..." PROVISION_MANAGER_PHONE="..." PROVISION_BUSINESS_NAME="..." PROVISION_CALENDAR_ID="..." PROVISION_TIMEZONE="..." npm run provision`
3. Ask the user for any missing provision values before running

### Migrations only ("migrate", "migrations")
1. Start Cloud SQL proxy: `./cloud-sql-proxy deepr-490316:europe-west3:deepr-project --port 5433 &`
2. Wait for "Listening" confirmation
3. Run: `DATABASE_URL="postgres://pa_user:150404@127.0.0.1:5433/pa4business" npm run db:migrate`
4. **Always run migration verification after** (see below)

### Change MiddleMan's number ("middleman number", "central number")
MiddleMan's WhatsApp number is a plain env var (not a secret). To change it:
1. Update the running service: `gcloud run services update pa-backend --region=europe-west3 --project=deepr-490316 --update-env-vars="PROVIDER_WA_NUMBER=+NEW_NUMBER"`
2. Update cloudbuild.yaml substitutions default (`_PROVIDER_WA_NUMBER`)
3. Verify the Cloud Build trigger substitution is also updated (the trigger overrides yaml defaults)

---

## Migration verification (REQUIRED after every deploy with new migrations)

`npm run db:migrate` can report "applied successfully" while silently skipping new migrations (journal hash mismatch). Always verify by checking a key new column:

```bash
./cloud-sql-proxy deepr-490316:europe-west3:deepr-project --port 5433 &
sleep 4
node --input-type=module <<'EOF'
import postgres from './node_modules/postgres/src/index.js';
const sql = postgres('postgres://pa_user:150404@127.0.0.1:5433/pa4business', { max: 1 });
const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name='businesses' ORDER BY column_name`;
console.log('businesses columns:', cols.map(c => c.column_name).join(', '));
await sql.end();
EOF
kill %1 2>/dev/null
```

If columns from new migration files are missing, apply the SQL directly — parse and run each statement from the migration `.sql` file manually via `sql.unsafe()`, skipping `42701`/`42P07`/`42710` errors (already exists).

---

## After every full deploy
1. Confirm the new revision is live: `gcloud run revisions list --service=pa-backend --region=europe-west3 --project=deepr-490316 --limit=1`
2. Check health: `curl -s https://pa-backend-d5jzekc5da-ey.a.run.app/health`
3. Verify these 3 env vars are set on the running revision (hardcoded in cloudbuild.yaml — should always be correct, but double-check):
   ```bash
   gcloud run services describe pa-backend --region=europe-west3 --project=deepr-490316 --format=json | python3 -c "
   import json,sys; data=json.load(sys.stdin)
   envs=data['spec']['template']['spec']['containers'][0].get('env',[])
   [print(e['name'],'=',e.get('value','[MISSING — fix immediately]')) for e in envs if e['name'] in ['PROVIDER_WA_NUMBER','OPERATOR_PHONE','PUBLIC_BASE_URL']]
   "
   ```
   If any show `[MISSING]`, set them: `gcloud run services update pa-backend --region=europe-west3 --project=deepr-490316 --update-env-vars="KEY=VALUE"` and also fix cloudbuild.yaml so it persists on the next deploy.

4. Report: version tag, revision name, health status

---

## Known gotchas

| Issue | Cause | Fix |
|---|---|---|
| Git push fails "password not supported" | GitHub removed password auth | User needs a PAT from github.com/settings/tokens |
| Cloud Build fails with "PROXY_PID not valid substitution" | Shell `$VAR` in bash steps parsed as Cloud Build substitution | Use `$$VAR` in bash scripts inside cloudbuild.yaml |
| `PROVIDER_WA_NUMBER` empty after deploy | Cloud Build trigger substitutions override yaml defaults | Check trigger substitutions match expected values |
| Migrations say "success" but columns missing | Drizzle journal hash mismatch silently skips new files | Always verify columns after deploy; apply SQL directly if needed |
| No reply from MiddleMan despite webhook hits | Provider WA token expired (expires every ~60 days) | Refresh token from Meta Developer Portal |
| Messages hit webhook but drop silently in 2ms | `PROVIDER_WA_NUMBER` env var is empty/wrong | Verify env var on running revision matches the test number |
