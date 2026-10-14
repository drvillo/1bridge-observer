#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container="observer-schema-test-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm -d --name "$container" -e POSTGRES_PASSWORD=observer-test postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres -d postgres >/dev/null

sql() {
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -At -U postgres -d "${1:-postgres}"
}

install_schema() {
  local database=${1:-postgres}
  local schema=${2:-public}
  local digest
  digest=$(shasum -a 256 "$repo_root/schema.sql" | cut -d ' ' -f 1)
  {
    printf 'BEGIN;\nSET LOCAL search_path = %s, public;\nSET LOCAL observer.schema_digest = '\''%s'\'';\n' "$schema" "$digest"
    cat "$repo_root/schema.sql"
    printf '\nCOMMIT;\n'
  } | sql "$database"
}

assert_rejected() {
  local statement=$1
  if printf '%s\n' "$statement" | sql >/dev/null 2>&1; then
    echo "Expected SQL to reject: $statement" >&2
    exit 1
  fi
}

# The script itself must be rerunnable without dropping retained evidence.
install_schema >/dev/null
install_schema >/dev/null
actual=$(printf "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('observer_schema_versions','observer_feeds','observer_cursors','observer_targets','observer_leaves','observer_checkpoints','observer_staged_leaves','observer_staged_checkpoints','observer_findings');" | sql)
test "$actual" = 9
actual=$(printf "SELECT version || ':' || length(schema_digest) FROM observer_schema_versions;" | sql)
test "$actual" = '1:64'

# A public marker must not be mistaken for a fresh customer-selected schema.
printf 'CREATE SCHEMA observer_tenant;\n' | sql >/dev/null
install_schema postgres observer_tenant >/dev/null
install_schema postgres observer_tenant >/dev/null
actual=$(printf "SELECT count(*) FROM information_schema.tables WHERE table_schema='observer_tenant' AND table_name LIKE 'observer_%%';" | sql)
test "$actual" = 9

assert_rejected "INSERT INTO observer_feeds(feed_id,anchor_pin,signed_anchor,source_base_url) VALUES ('bad','$(printf 'a%.0s' {1..64})',decode('01','hex'),'https://example.test');"

feed=$(printf 'a%.0s' {1..64})
pin=$(printf 'b%.0s' {1..64})
hash=$(printf 'c%.0s' {1..64})
printf "INSERT INTO observer_feeds(feed_id,anchor_pin,signed_anchor,source_base_url) VALUES ('%s','%s',decode('01','hex'),'https://example.test');\n" "$feed" "$pin" | sql >/dev/null
printf "INSERT INTO observer_cursors(feed_id) VALUES ('%s');\n" "$feed" | sql >/dev/null
actual=$(printf "SELECT staged_next_index || ':' || accepted_size || ':' || version || ':' || lease_epoch FROM observer_cursors WHERE feed_id='%s';\n" "$feed" | sql)
test "$actual" = '0:0:0:0'

assert_rejected "INSERT INTO observer_leaves(feed_id,leaf_index,leaf_hash,leaf_bytes) VALUES ('$feed',-1,'$hash',decode('01','hex'));"
assert_rejected "INSERT INTO observer_leaves(feed_id,leaf_index,leaf_hash,leaf_bytes) VALUES ('$feed',9007199254740992,'$hash',decode('01','hex'));"
assert_rejected "INSERT INTO observer_leaves(feed_id,leaf_index,leaf_hash,leaf_bytes) VALUES ('$feed',0,'$hash',decode('','hex'));"
assert_rejected "UPDATE observer_cursors SET accepted_size=9007199254740992 WHERE feed_id='$feed';"
assert_rejected "UPDATE observer_cursors SET staged_next_index=-1 WHERE feed_id='$feed';"
assert_rejected "UPDATE observer_cursors SET lease_owner='worker' WHERE feed_id='$feed';"
assert_rejected "UPDATE observer_cursors SET accepted_size=1, staged_next_index=1 WHERE feed_id='$feed';"
assert_rejected "UPDATE observer_cursors SET accepted_checkpoint_hash='$hash' WHERE feed_id='$feed';"
assert_rejected "INSERT INTO observer_staged_leaves(feed_id,attempt_id,leaf_index,leaf_hash,leaf_bytes) VALUES ('$feed',1,0,'$hash',decode('01','hex'));"

printf "INSERT INTO observer_targets(feed_id,target_hash,target_size,signed_checkpoint) VALUES ('%s','%s',1,decode('01','hex'));\n" "$feed" "$hash" | sql >/dev/null
assert_rejected "INSERT INTO observer_targets(feed_id,target_hash,target_size,signed_checkpoint) VALUES ('$feed','$hash',1,decode('01','hex'));"
assert_rejected "INSERT INTO observer_targets(feed_id,attempt_id,target_hash,target_size,signed_checkpoint,status,finished_at) VALUES ('$feed',99,'$hash',1,decode('01','hex'),'quarantined',clock_timestamp());"
assert_rejected "INSERT INTO observer_findings(finding_id,feed_id,finding_type,evidence_bytes) VALUES (99,'$feed','gap',decode('01','hex'));"
assert_rejected "UPDATE observer_cursors SET active_attempt_id=2 WHERE feed_id='$feed';"
assert_rejected "UPDATE observer_cursors SET active_attempt_id=1, staged_checkpoint_tail_hash='$hash', staged_checkpoint_tail_position=0 WHERE feed_id='$feed';"
printf "INSERT INTO observer_staged_checkpoints(feed_id,attempt_id,position,statement_hash,checkpoint_size,signed_checkpoint) VALUES ('%s',1,0,'%s',0,decode('01','hex'));\n" "$feed" "$hash" | sql >/dev/null
printf "UPDATE observer_cursors SET active_attempt_id=1, staged_checkpoint_tail_hash='%s', staged_checkpoint_tail_position=0 WHERE feed_id='%s';\n" "$hash" "$feed" | sql >/dev/null
assert_rejected "UPDATE observer_cursors SET active_attempt_id=NULL WHERE feed_id='$feed';"

actual=$(printf "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='observer_findings_unresolved_idx';" | sql)
test "$actual" = 1

# A colliding observer-prefixed object must fail before creating any schema tables.
printf "CREATE DATABASE collision;\n" | sql >/dev/null
printf "CREATE TABLE observer_feeds (impostor integer);\n" | sql collision >/dev/null
if install_schema collision >/dev/null 2>&1; then
  echo 'Expected existing observer object to block installation' >&2
  exit 1
fi
actual=$(printf "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='observer_schema_versions';" | sql collision)
test "$actual" = 0

# A failure after all DDL but before COMMIT rolls the entire install back.
printf "CREATE DATABASE rollback_case;\n" | sql >/dev/null
digest=$(shasum -a 256 "$repo_root/schema.sql" | cut -d ' ' -f 1)
if {
  printf 'BEGIN;\nSET LOCAL observer.schema_digest = '\''%s'\'';\n' "$digest"
  cat "$repo_root/schema.sql"
  printf '\nSELECT 1/0;\nCOMMIT;\n'
} | sql rollback_case >/dev/null 2>&1; then
  echo 'Expected forced pre-commit failure' >&2
  exit 1
fi
actual=$(printf "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'observer_%%';" | sql rollback_case)
test "$actual" = 0

# Unsupported marker versions must fail without changing existing rows.
printf "UPDATE observer_schema_versions SET schema_digest='%s';\n" "$hash" | sql >/dev/null
if install_schema >/dev/null 2>&1; then
  echo 'Expected changed schema digest to block repeated installation' >&2
  exit 1
fi
digest=$(shasum -a 256 "$repo_root/schema.sql" | cut -d ' ' -f 1)
printf "UPDATE observer_schema_versions SET schema_digest='%s';\n" "$digest" | sql >/dev/null
install_schema >/dev/null 2>&1
assert_rejected "UPDATE observer_schema_versions SET version=2;"

# Detect a structurally incomplete repeat install rather than silently recreating it.
printf "DROP TABLE observer_findings;\n" | sql >/dev/null
if install_schema >/dev/null 2>&1; then
  echo 'Expected missing observer table to block repeated installation' >&2
  exit 1
fi

echo 'observer schema: fresh/repeat install, marker, constraints, FK, indexes and transactional rollback passed'
