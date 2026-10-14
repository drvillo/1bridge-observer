#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container=${OBSERVER_SUPABASE_CONTAINER:-}
if [[ -z "$container" ]]; then
  echo 'Set OBSERVER_SUPABASE_CONTAINER to an existing local Supabase Postgres container' >&2
  exit 2
fi
image=$(docker inspect --format '{{.Config.Image}}' "$container")
if [[ "$image" != *supabase/postgres:* ]]; then
  echo 'Refusing to run against a container without a Supabase Postgres image' >&2
  exit 2
fi

database="observer_schema_probe_$$"
created=false
cleanup() {
  if [[ "$created" = true ]]; then
    docker exec "$container" dropdb -U postgres --if-exists --force "$database" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker exec "$container" createdb -U postgres "$database"
created=true
sql() {
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -At -U postgres -d "$database"
}

printf 'CREATE SCHEMA observer_probe;\n' | sql >/dev/null
digest=$(shasum -a 256 "$repo_root/schema.sql" | cut -d ' ' -f 1)
for _ in 1 2; do
  {
    printf "BEGIN;\nSET LOCAL search_path = observer_probe, public;\nSET LOCAL observer.schema_digest = '%s';\n" "$digest"
    cat "$repo_root/schema.sql"
    printf '\nCOMMIT;\n'
  } | sql >/dev/null
done

actual=$(printf "SELECT count(*) FROM information_schema.tables WHERE table_schema='observer_probe' AND table_name LIKE 'observer_%%';\n" | sql)
test "$actual" = 9
actual=$(printf "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'observer_%%';\n" | sql)
test "$actual" = 0
actual=$(printf "SET search_path = observer_probe, public; SELECT version || ':' || schema_digest FROM observer_schema_versions;\n" | sql | tail -n 1)
test "$actual" = "1:$digest"

version=$(printf 'SHOW server_version;\n' | sql)
echo "observer schema: fresh/repeat selected-schema install passed on Supabase Postgres $version in a disposable database"
