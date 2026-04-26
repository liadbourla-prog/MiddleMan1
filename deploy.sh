#!/usr/bin/env bash
# Usage:
#   ./deploy.sh              — auto-increments patch version (e.g. v1.2.3 → v1.2.4)
#   ./deploy.sh v2.0.0       — deploys a specific version tag
#   ./deploy.sh --watch      — deploy + stream Cloud Build logs until done
#
# The script commits any staged/unstaged changes, tags the release, pushes to
# main, and Cloud Build takes it from there (migrate → build → deploy).

set -euo pipefail

PROJECT_ID="deepr-490316"
REGION="europe-west3"
SERVICE="pa-backend"
REPO="liadbourla-prog/MiddleMan1"

# ── Resolve version ────────────────────────────────────────────────────────────
WATCH=false
VERSION_ARG=""
for arg in "$@"; do
  if [[ "$arg" == "--watch" ]]; then WATCH=true
  else VERSION_ARG="$arg"
  fi
done

if [[ -n "$VERSION_ARG" ]]; then
  NEXT_VERSION="$VERSION_ARG"
else
  LAST=$(git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)
  if [[ -z "$LAST" ]]; then
    NEXT_VERSION="v1.0.0"
  else
    IFS='.' read -r MAJOR MINOR PATCH <<< "${LAST#v}"
    NEXT_VERSION="v${MAJOR}.${MINOR}.$((PATCH + 1))"
  fi
fi

echo "🚀  Deploying $NEXT_VERSION"

# ── Commit any pending changes ─────────────────────────────────────────────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -m "chore: release $NEXT_VERSION"
fi

# ── Tag ────────────────────────────────────────────────────────────────────────
if git tag | grep -q "^${NEXT_VERSION}$"; then
  echo "⚠️  Tag $NEXT_VERSION already exists — skipping tag creation"
else
  git tag -a "$NEXT_VERSION" -m "Release $NEXT_VERSION"
  echo "🏷   Tagged $NEXT_VERSION"
fi

# ── Push ───────────────────────────────────────────────────────────────────────
git push origin main --tags
echo "📤  Pushed to GitHub — Cloud Build will now:"
echo "    1. Run DB migrations"
echo "    2. Build & push Docker image ($NEXT_VERSION / latest)"
echo "    3. Deploy to Cloud Run ($SERVICE)"
echo ""
echo "🔗  Monitor: https://console.cloud.google.com/cloud-build/builds?project=$PROJECT_ID"

# ── Optional: stream logs ──────────────────────────────────────────────────────
if [[ "$WATCH" == true ]]; then
  echo ""
  echo "⏳  Waiting for build to start..."
  sleep 8
  BUILD_ID=$(gcloud builds list --project="$PROJECT_ID" --limit=1 \
    --format="value(id)" 2>/dev/null)
  if [[ -n "$BUILD_ID" ]]; then
    echo "📋  Streaming build $BUILD_ID"
    gcloud builds log --stream "$BUILD_ID" --project="$PROJECT_ID" 2>/dev/null
    STATUS=$(gcloud builds describe "$BUILD_ID" --project="$PROJECT_ID" \
      --format="value(status)" 2>/dev/null)
    if [[ "$STATUS" == "SUCCESS" ]]; then
      echo ""
      echo "✅  Deploy complete!"
      echo "🌐  Service: https://$(gcloud run services describe $SERVICE \
        --region=$REGION --project=$PROJECT_ID \
        --format='value(status.url)' 2>/dev/null | sed 's|https://||')"
    else
      echo "❌  Build $STATUS — check logs above"
      exit 1
    fi
  fi
fi
