-- Observer schema v4: durable shared-registry cursor and exact staged evidence.
-- Run only inside the installer's transaction after checking the installed catalog.
SELECT pg_advisory_xact_lock(6704462056185601401);
SELECT set_config('search_path', 'observer', true);

DO $observer_v4_preflight$
DECLARE
  marker_count integer;
  marker_version integer;
  marker_digest text;
  table_count integer;
  expected_digest text := current_setting('observer.schema_digest', true);
  previous_digest text := current_setting('observer.previous_schema_digest', true);
BEGIN
  IF expected_digest IS NULL OR expected_digest !~ '^[0-9a-f]{64}$'
    OR previous_digest IS NULL OR previous_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Missing or malformed observer migration digest';
  END IF;
  IF to_regclass(format('%I.observer_schema_versions', 'observer')) IS NULL THEN
    RAISE EXCEPTION 'Observer v3 schema must be installed before v4';
  END IF;
  SELECT count(*), min(version), min(schema_digest)
    INTO marker_count, marker_version, marker_digest FROM observer.observer_schema_versions;
  IF marker_count <> 1 OR NOT (
    (marker_version = 3 AND marker_digest = previous_digest)
    OR (marker_version = 4 AND marker_digest = expected_digest)
  ) THEN
    RAISE EXCEPTION 'Unsupported observer schema marker';
  END IF;
  IF marker_version = 4 THEN
    SELECT count(*) INTO table_count
      FROM pg_class AS object
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'observer'
        AND object.relkind IN ('r', 'p')
        AND object.relname IN (
          'observer_schema_versions', 'observer_feeds', 'observer_cursors',
          'observer_targets', 'observer_leaves', 'observer_checkpoints',
          'observer_staged_leaves', 'observer_staged_checkpoints',
          'observer_findings', 'observer_reports', 'observer_known_receipts',
          'observer_registry_cursor', 'observer_registry_entries',
          'observer_registry_checkpoints', 'observer_registry_staged_entries',
          'observer_registry_staged_checkpoints', 'observer_registry_findings',
          'observer_aggregate_reports'
        );
    IF table_count <> 18 THEN
      RAISE EXCEPTION 'Incomplete observer schema';
    END IF;
  END IF;
  PERFORM set_config('observer.migrating_from_v3',
    CASE WHEN marker_version = 3 THEN 'yes' ELSE 'no' END, true);
  IF marker_version = 3 THEN
    EXECUTE 'ALTER TABLE observer.observer_schema_versions DROP CONSTRAINT observer_schema_versions_version_check';
  END IF;
END;
$observer_v4_preflight$;

CREATE TABLE IF NOT EXISTS observer.observer_registry_cursor (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  publisher_key_id text NOT NULL CHECK (publisher_key_id ~ '^[0-9a-f]{64}$'),
  genesis_hash text NOT NULL CHECK (genesis_hash ~ '^[0-9a-f]{64}$'),
  signed_genesis bytea NOT NULL CHECK (octet_length(signed_genesis) BETWEEN 1 AND 16384),
  accepted_hash text NOT NULL CHECK (accepted_hash ~ '^[0-9a-f]{64}$'),
  accepted_size bigint NOT NULL DEFAULT 0 CHECK (accepted_size BETWEEN 0 AND 9007199254740991),
  target_hash text CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  target_size bigint CHECK (target_size BETWEEN 0 AND 9007199254740991),
  signed_target bytea CHECK (signed_target IS NULL OR octet_length(signed_target) BETWEEN 1 AND 16384),
  staged_next_index bigint NOT NULL DEFAULT 0 CHECK (staged_next_index BETWEEN 0 AND 9007199254740991),
  staged_checkpoint_tail_hash text CHECK (staged_checkpoint_tail_hash ~ '^[0-9a-f]{64}$'),
  next_feed_offset bigint NOT NULL DEFAULT 0 CHECK (next_feed_offset BETWEEN 0 AND 9007199254740991),
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch BETWEEN 0 AND 9007199254740991),
  lease_owner text CHECK (length(lease_owner) BETWEEN 1 AND 256),
  lease_until timestamptz,
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((target_hash IS NULL) = (target_size IS NULL)),
  CHECK ((target_hash IS NULL) = (signed_target IS NULL)),
  CHECK (target_hash IS NOT NULL OR staged_checkpoint_tail_hash IS NULL),
  CHECK (staged_next_index >= accepted_size),
  CHECK (accepted_size > 0 OR accepted_hash = genesis_hash)
);

CREATE TABLE IF NOT EXISTS observer.observer_registry_entries (
  entry_index bigint PRIMARY KEY CHECK (entry_index BETWEEN 0 AND 9007199254740991),
  leaf_hash text NOT NULL CHECK (leaf_hash ~ '^[0-9a-f]{64}$'),
  entry_bytes bytea NOT NULL CHECK (octet_length(entry_bytes) BETWEEN 1 AND 32768)
);

CREATE TABLE IF NOT EXISTS observer.observer_registry_checkpoints (
  position bigint PRIMARY KEY CHECK (position BETWEEN 0 AND 9007199254740991),
  statement_hash text NOT NULL UNIQUE CHECK (statement_hash ~ '^[0-9a-f]{64}$'),
  checkpoint_size bigint NOT NULL CHECK (checkpoint_size BETWEEN 0 AND 9007199254740991),
  previous_hash text CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  signed_checkpoint bytea NOT NULL CHECK (octet_length(signed_checkpoint) BETWEEN 1 AND 16384),
  consistency_proof jsonb NOT NULL CHECK (jsonb_typeof(consistency_proof) = 'array'),
  CHECK ((position = 0) = (previous_hash IS NULL))
);

CREATE TABLE IF NOT EXISTS observer.observer_registry_staged_entries (
  target_hash text NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  entry_index bigint NOT NULL CHECK (entry_index BETWEEN 0 AND 9007199254740991),
  leaf_hash text NOT NULL CHECK (leaf_hash ~ '^[0-9a-f]{64}$'),
  entry_bytes bytea NOT NULL CHECK (octet_length(entry_bytes) BETWEEN 1 AND 32768),
  PRIMARY KEY (target_hash, entry_index)
);

CREATE TABLE IF NOT EXISTS observer.observer_registry_staged_checkpoints (
  target_hash text NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  position bigint NOT NULL CHECK (position BETWEEN 1 AND 9007199254740991),
  statement_hash text NOT NULL CHECK (statement_hash ~ '^[0-9a-f]{64}$'),
  checkpoint_size bigint NOT NULL CHECK (checkpoint_size BETWEEN 0 AND 9007199254740991),
  previous_hash text NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  signed_checkpoint bytea NOT NULL CHECK (octet_length(signed_checkpoint) BETWEEN 1 AND 16384),
  consistency_proof jsonb NOT NULL CHECK (jsonb_typeof(consistency_proof) = 'array'),
  PRIMARY KEY (target_hash, position),
  UNIQUE (target_hash, statement_hash)
);

CREATE TABLE IF NOT EXISTS observer.observer_registry_findings (
  finding_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_hash text CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  finding_type text NOT NULL CHECK (finding_type IN ('source_nonconformance', 'invalid_replay', 'fork')),
  evidence_bytes bytea NOT NULL CHECK (octet_length(evidence_bytes) BETWEEN 1 AND 16384),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  UNIQUE (finding_type, evidence_bytes)
);

CREATE TABLE IF NOT EXISTS observer.observer_aggregate_reports (
  report_hash text PRIMARY KEY CHECK (report_hash ~ '^[0-9a-f]{64}$'),
  registry_hash text NOT NULL REFERENCES observer.observer_registry_checkpoints(statement_hash) ON DELETE RESTRICT,
  observer_key_id text NOT NULL CHECK (observer_key_id ~ '^[0-9a-f]{64}$'),
  signed_report bytea NOT NULL CHECK (octet_length(signed_report) BETWEEN 1 AND 16384),
  registry_snapshot bytea NOT NULL CHECK (octet_length(registry_snapshot) BETWEEN 1 AND 33554432),
  verified_snapshots bytea NOT NULL CHECK (octet_length(verified_snapshots) BETWEEN 1 AND 33554432),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS observer_aggregate_reports_created_idx
  ON observer.observer_aggregate_reports(created_at DESC);

DO $observer_v4_marker$
DECLARE marker_version integer;
BEGIN
  SELECT version INTO marker_version FROM observer.observer_schema_versions;
  IF marker_version = 3 THEN
    UPDATE observer.observer_schema_versions
      SET version = 4, schema_digest = current_setting('observer.schema_digest');
    EXECUTE 'ALTER TABLE observer.observer_schema_versions ADD CONSTRAINT observer_schema_versions_version_check CHECK (version = 4)';
  END IF;
END;
$observer_v4_marker$;

-- The catalog fingerprint below covers all observer-owned tables, indexes,
-- constraints and policies. It detects accidental DDL drift, not hostile DBAs.
DO $observer_catalog$
DECLARE
  actual_fingerprint text;
  stored_fingerprint text;
BEGIN
  SELECT md5(jsonb_build_object(
    'objects', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, object.relkind,
        object.relpersistence, object.relrowsecurity, object.relforcerowsecurity)
        ORDER BY object.relname)
      FROM pg_class AS object
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'observer' AND left(object.relname, 9) = 'observer_'
    ),
    'columns', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, column_entry.attnum,
        column_entry.attname, format_type(column_entry.atttypid, column_entry.atttypmod),
        column_entry.attnotnull, column_entry.attidentity, column_entry.attgenerated,
        pg_get_expr(default_entry.adbin, default_entry.adrelid))
        ORDER BY object.relname, column_entry.attnum)
      FROM pg_class AS object
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      JOIN pg_attribute AS column_entry ON column_entry.attrelid = object.oid
      LEFT JOIN pg_attrdef AS default_entry
        ON default_entry.adrelid = object.oid AND default_entry.adnum = column_entry.attnum
      WHERE namespace.nspname = 'observer' AND left(object.relname, 9) = 'observer_'
        AND object.relkind IN ('r', 'p') AND column_entry.attnum > 0
        AND NOT column_entry.attisdropped
    ),
    'constraints', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, constraint_entry.conname,
        constraint_entry.contype, pg_get_constraintdef(constraint_entry.oid, true))
        ORDER BY object.relname, constraint_entry.conname)
      FROM pg_constraint AS constraint_entry
      JOIN pg_class AS object ON object.oid = constraint_entry.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'observer' AND left(object.relname, 9) = 'observer_'
    ),
    'indexes', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, index_object.relname,
        pg_get_indexdef(index_entry.indexrelid)) ORDER BY object.relname, index_object.relname)
      FROM pg_index AS index_entry
      JOIN pg_class AS object ON object.oid = index_entry.indrelid
      JOIN pg_class AS index_object ON index_object.oid = index_entry.indexrelid
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'observer' AND left(object.relname, 9) = 'observer_'
    ),
    'triggers', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, trigger_entry.tgname,
        pg_get_triggerdef(trigger_entry.oid)) ORDER BY object.relname, trigger_entry.tgname)
      FROM pg_trigger AS trigger_entry
      JOIN pg_class AS object ON object.oid = trigger_entry.tgrelid
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'observer' AND left(object.relname, 9) = 'observer_'
        AND NOT trigger_entry.tgisinternal
    ),
    'policies', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, policy_entry.polname,
        policy_entry.polcmd, policy_entry.polpermissive,
        pg_get_expr(policy_entry.polqual, policy_entry.polrelid),
        pg_get_expr(policy_entry.polwithcheck, policy_entry.polrelid))
        ORDER BY object.relname, policy_entry.polname)
      FROM pg_policy AS policy_entry
      JOIN pg_class AS object ON object.oid = policy_entry.polrelid
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'observer' AND left(object.relname, 9) = 'observer_'
    ),
    'sequences', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, sequence_entry.seqtypid::regtype::text,
        sequence_entry.seqstart, sequence_entry.seqincrement, sequence_entry.seqmax,
        sequence_entry.seqmin, sequence_entry.seqcache, sequence_entry.seqcycle)
        ORDER BY object.relname)
      FROM pg_sequence AS sequence_entry
      JOIN pg_class AS object ON object.oid = sequence_entry.seqrelid
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'observer' AND left(object.relname, 9) = 'observer_'
    )
  )::text) INTO actual_fingerprint;

  SELECT catalog_fingerprint INTO stored_fingerprint FROM observer.observer_schema_versions WHERE version = 4;
  IF stored_fingerprint IS DISTINCT FROM actual_fingerprint THEN
    IF current_setting('observer.migrating_from_v3', true) = 'yes' THEN
      UPDATE observer.observer_schema_versions SET catalog_fingerprint = actual_fingerprint WHERE version = 4;
    ELSE
      RAISE EXCEPTION 'Observer schema catalog has changed';
    END IF;
  END IF;
END;
$observer_catalog$;
