#!/usr/bin/env bash
set -euo pipefail

container=${OBSERVER_SUPABASE_CONTAINER:-}
source_url=${OBSERVER_SUPABASE_DATABASE_URL:-}
if [[ -z "$container" || -z "$source_url" ]]; then
  echo 'Set OBSERVER_SUPABASE_CONTAINER and a local OBSERVER_SUPABASE_DATABASE_URL' >&2
  exit 2
fi
image=$(docker inspect --format '{{.Config.Image}}' "$container")
if [[ "$image" != *supabase/postgres:* ]]; then
  echo 'Refusing to run against a container without a Supabase Postgres image' >&2
  exit 2
fi

database="observer_store_probe_$$"
created=false
cleanup() {
  if [[ "$created" = true ]]; then
    docker exec "$container" dropdb -U postgres --if-exists --force "$database" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker exec "$container" createdb -U postgres "$database"
created=true
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$database" \
  -c 'CREATE SCHEMA observer_test; CREATE SCHEMA observer_parallel; CREATE SCHEMA observer_upgrade; CREATE SCHEMA observer_upgrade_v2; CREATE SCHEMA observer_registry; CREATE SCHEMA observer_registry_poll; CREATE SCHEMA observer_registry_poll_gap; CREATE SCHEMA observer_shared_poll; CREATE SCHEMA observer_shared_poll_partial; CREATE SCHEMA observer_shared_poll_error; CREATE SCHEMA observer_shared_route; CREATE SCHEMA observer_fixed_target; CREATE SCHEMA observer_report; CREATE SCHEMA observer_receipt_partial; CREATE SCHEMA observer_receipt_store; CREATE SCHEMA observer_report_route; CREATE SCHEMA observer_poll; CREATE SCHEMA observer_poll_unavailable; CREATE SCHEMA observer_poll_invalid; CREATE SCHEMA observer_poll_protocol; CREATE SCHEMA observer_route' >/dev/null
export OBSERVER_TEST_DATABASE_NAME="$database"
export OBSERVER_SUPABASE_DATABASE_URL="$source_url"
OBSERVER_TEST_DATABASE_URL=$(node -e '
  const url = new URL(process.env.OBSERVER_SUPABASE_DATABASE_URL)
  if (!/^(postgres|postgresql):$/.test(url.protocol) || !url.hostname || url.hash) process.exit(2)
  url.pathname = "/" + process.env.OBSERVER_TEST_DATABASE_NAME
  process.stdout.write(url.href)
')
export OBSERVER_TEST_DATABASE_URL
pnpm exec vitest run --config vitest.integration.config.ts
