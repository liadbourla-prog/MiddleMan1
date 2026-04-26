# Update Agent

Deploys the MiddleMan project to production. Execute only when the user explicitly asks to deploy or update.

## Project context
- **Repo**: https://github.com/liadbourla-prog/MiddleMan1
- **Cloud Run service**: pa-backend (europe-west3, project: deepr-490316)
- **Live URL**: https://pa-backend-d5jzekc5da-ey.a.run.app
- **Deploy script**: `./deploy.sh` in project root
- **Pipeline**: push to main → Cloud Build (migrate → build → push → Cloud Run deploy)

## Arguments: $ARGUMENTS

Parse the arguments to determine the deploy scope. If no arguments, do a full deploy.

---

## Scope options

### Full deploy (default — no args or "full")
Commits all changes, tags a new version, pushes to GitHub, and Cloud Build handles everything:
1. Run `./deploy.sh --watch` from the project root
2. Report the version tag created and confirm build succeeded

### Code only ("code", "code-only")
Deploy new code without triggering a migration step concern:
1. Run `./deploy.sh --watch`
2. Same as full deploy — migrations are safe to re-run (idempotent)

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
| Provider WA token | provider-wa-access-token | PROVIDER_WA_ACCESS_TOKEN |
| Google client secret | GOOGLE_CLIENT_SECRET | GOOGLE_CLIENT_SECRET |
| Database URL | DATABASE_URL | DATABASE_URL |
| Redis URL | REDIS_URL | REDIS_URL |

### Provision new business ("provision", "new business", "add business")
Add a new business to the system without redeploying code:
1. Start Cloud SQL proxy locally: `./cloud-sql-proxy deepr-490316:europe-west3:deepr-project --port 5433 &`
2. Run: `DATABASE_URL="postgres://pa_user:150404@127.0.0.1:5433/pa4business" PROVISION_WA_NUMBER="..." PROVISION_MANAGER_PHONE="..." PROVISION_BUSINESS_NAME="..." PROVISION_CALENDAR_ID="..." PROVISION_TIMEZONE="..." npm run provision`
3. Ask the user for any missing provision values before running

### Migrations only ("migrate", "migrations")
Run DB migrations without redeploying code:
1. Start Cloud SQL proxy: `./cloud-sql-proxy deepr-490316:europe-west3:deepr-project --port 5433 &`
2. Wait for "Listening" confirmation
3. Run: `DATABASE_URL="postgres://pa_user:150404@127.0.0.1:5433/pa4business" npm run db:migrate`

---

## After every full deploy
1. Confirm the new revision is live: `gcloud run revisions list --service=pa-backend --region=europe-west3 --project=deepr-490316 --limit=1`
2. Check health: `curl -s https://pa-backend-d5jzekc5da-ey.a.run.app/health`
3. Report: version tag, revision name, health status

## What stays wired automatically (no action needed)
- Meta webhook URL is stable — no re-registration needed
- All secrets injected via Cloud Run — no manual env var updates
- All existing business agents and their data persist across deploys
- New code abilities become available to all agents (central + per-business) immediately on deploy
