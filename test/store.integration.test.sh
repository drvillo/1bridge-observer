#!/usr/bin/env bash
set -euo pipefail

container="observer-store-test-$$"
postgres_image="${OBSERVER_TEST_POSTGRES_IMAGE:-postgres:17}"
cleanup() {
  docker stop --time 1 "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm -d --name "$container" -e POSTGRES_PASSWORD=observer-test \
  -p 127.0.0.1::5432 "$postgres_image" >/dev/null
export OBSERVER_TEST_POSTGRES_IMAGE="$postgres_image"
export OBSERVER_TEST_POSTGRES_IMAGE_ID="$(docker inspect "$container" --format '{{.Image}}')"
export OBSERVER_TEST_POSTGRES_IMAGE_ARCHITECTURE="$(docker image inspect "$postgres_image" --format '{{.Architecture}}')"
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$(dirname "${BASH_SOURCE[0]}")/integration-schemas.sql" >/dev/null
port=$(docker port "$container" 5432/tcp | awk -F: 'END { print $NF }')
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo 'Docker did not publish the test Postgres port' >&2
  exit 1
fi
export OBSERVER_TEST_DATABASE_URL="postgresql://postgres:observer-test@127.0.0.1:$port/postgres"
export OBSERVER_DISPOSABLE_DATABASE=1
pnpm exec vitest run --config "${1:-vitest.integration.config.ts}"
