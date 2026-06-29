#!/usr/bin/env bash
# ============================================================================
# WS1 merge-gate concurrency harness — ephemeral Postgres wrapper.
#
# Boots a throwaway Postgres 16 cluster, applies ALL migrations into it, runs the
# tests/concurrency/** suite against it under REAL connection-level contention, then
# tears the whole cluster down on EXIT (success, failure, or Ctrl-C).
#
#   *** NEVER run this against production. NEVER. ***
#
# This script refuses to proceed unless DATABASE_URL resolves to a 127.0.0.1 ephemeral
# cluster on a high port that it booted itself. Prod-proxy ports (5432/5433/5434) are
# hard-rejected. The cluster lives in a unique /tmp/pg_ws1_harness_* dir and is rm -rf'd
# on teardown — it never touches the user's real DB, Cloud SQL proxy, or any shared state.
#
# macOS quirks already solved (do not remove):
#   - LC_ALL=C LANG=C for BOTH initdb and server start (else "postmaster became
#     multithreaded" / "invalid locale" on this machine).
#   - Unix socket dir must be SHORT (<103 bytes) → -k /tmp, and we connect over TCP
#     127.0.0.1 rather than the scratchpad socket path.
# ============================================================================
set -euo pipefail

export LC_ALL=C LANG=C

PG_PREFIX=/opt/homebrew/bin
INITDB="$PG_PREFIX/initdb"
PG_CTL="$PG_PREFIX/pg_ctl"
CREATEDB="$PG_PREFIX/createdb"

for bin in "$INITDB" "$PG_CTL" "$CREATEDB"; do
  if [[ ! -x "$bin" ]]; then
    echo "FATAL: required Postgres binary missing or not executable: $bin" >&2
    exit 1
  fi
done

# ── Pick a unique data dir (short path) and a free-ish high port ─────────────
PGDATA="/tmp/pg_ws1_harness_$$_$RANDOM"
# High ephemeral port, deliberately far from prod-proxy ports (5432/5433/5434).
PORT=$(( 54000 + (RANDOM % 4000) ))

# Guard: never, ever the prod-proxy ports.
if [[ "$PORT" == "5432" || "$PORT" == "5433" || "$PORT" == "5434" ]]; then
  echo "FATAL: refusing to use prod-proxy port $PORT" >&2
  exit 1
fi

PG_STARTED=0

cleanup() {
  local rc=$?
  if [[ "$PG_STARTED" == "1" ]]; then
    echo "── tearing down ephemeral Postgres (PGDATA=$PGDATA) ──"
    "$PG_CTL" -D "$PGDATA" -w stop -m immediate >/dev/null 2>&1 || true
  fi
  rm -rf "$PGDATA" 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT INT TERM

echo "── initdb (ephemeral, trust auth, no locale) ──"
"$INITDB" -D "$PGDATA" -U postgres --auth=trust --no-locale -E UTF8 >/dev/null

echo "── starting ephemeral Postgres on 127.0.0.1:$PORT ──"
"$PG_CTL" -D "$PGDATA" \
  -o "-p $PORT -c listen_addresses=127.0.0.1 -k /tmp" \
  -l "$PGDATA/server.log" -w start
PG_STARTED=1

"$CREATEDB" -h 127.0.0.1 -p "$PORT" -U postgres pa_harness

EPHEMERAL_URL="postgresql://postgres@127.0.0.1:$PORT/pa_harness"

# ── Guard rail: assert the URL we are about to use is the local ephemeral one. ──
# Refuse to run if it does not point at 127.0.0.1, or if it smells like a prod proxy.
if [[ "$EPHEMERAL_URL" != postgresql://*@127.0.0.1:* ]]; then
  echo "FATAL: ephemeral DATABASE_URL is not 127.0.0.1 — refusing: $EPHEMERAL_URL" >&2
  exit 1
fi
case "$EPHEMERAL_URL" in
  *:5432/* | *:5433/* | *:5434/*)
    echo "FATAL: ephemeral DATABASE_URL hit a prod-proxy port — refusing: $EPHEMERAL_URL" >&2
    exit 1
    ;;
esac

echo "── applying ALL migrations into ephemeral DB ──"
DATABASE_URL="$EPHEMERAL_URL" npm run db:apply

echo "── running concurrency suite (raceN, C1–C7) ──"
set +e
DATABASE_URL="$EPHEMERAL_URL" npx vitest run --config vitest.concurrency.config.ts "$@"
VITEST_RC=$?
set -e

echo "── concurrency suite exit code: $VITEST_RC ──"
# Propagate vitest's exit code (cleanup trap runs on EXIT and preserves it).
exit "$VITEST_RC"
