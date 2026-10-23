-- Observer schema v2: append-only signed coverage reports. Run inside the
-- installer's transaction, after validating v1, with both digest settings.
SELECT pg_advisory_xact_lock(6704462056185601401);
SELECT set_config('search_path', 'observer', true);

DO $observer_v2_preflight$
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
    RAISE EXCEPTION 'Observer v1 schema must be installed before v2';
  END IF;
  SELECT count(*), min(version), min(schema_digest)
    INTO marker_count, marker_version, marker_digest FROM observer.observer_schema_versions;
  IF marker_count <> 1 OR NOT (
    (marker_version = 1 AND marker_digest = previous_digest)
    OR (marker_version = 2 AND marker_digest = expected_digest)
  ) THEN
    RAISE EXCEPTION 'Unsupported observer schema marker';
  END IF;
  IF marker_version = 2 THEN
    SELECT count(*) INTO table_count
      FROM pg_class AS object
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'observer'
        AND object.relkind IN ('r', 'p')
        AND object.relname IN (
          'observer_schema_versions', 'observer_feeds', 'observer_cursors',
          'observer_targets', 'observer_leaves', 'observer_checkpoints',
          'observer_staged_leaves', 'observer_staged_checkpoints',
          'observer_findings', 'observer_reports'
        );
    IF table_count <> 10 THEN
      RAISE EXCEPTION 'Incomplete observer schema';
    END IF;
  END IF;
  PERFORM set_config('observer.migrating_from_v1',
    CASE WHEN marker_version = 1 THEN 'yes' ELSE 'no' END, true);
  IF marker_version = 1 THEN
    EXECUTE 'ALTER TABLE observer.observer_schema_versions DROP CONSTRAINT observer_schema_versions_version_check';
    EXECUTE 'ALTER TABLE observer.observer_cursors ADD COLUMN report_revision bigint NOT NULL DEFAULT 0 CHECK (report_revision BETWEEN 0 AND 9007199254740991)';
  END IF;
END;
$observer_v2_preflight$;

CREATE TABLE IF NOT EXISTS observer.observer_reports (
  report_hash text PRIMARY KEY CHECK (report_hash ~ '^[0-9a-f]{64}$'),
  feed_id text NOT NULL REFERENCES observer.observer_feeds(feed_id) ON DELETE RESTRICT,
  covered_checkpoint_hash text NOT NULL CHECK (covered_checkpoint_hash ~ '^[0-9a-f]{64}$'),
  observer_key_id text NOT NULL CHECK (observer_key_id ~ '^[0-9a-f]{64}$'),
  report_revision bigint NOT NULL CHECK (report_revision BETWEEN 0 AND 9007199254740991),
  signed_report bytea NOT NULL CHECK (octet_length(signed_report) BETWEEN 1 AND 16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (feed_id, report_revision, observer_key_id),
  FOREIGN KEY (feed_id, covered_checkpoint_hash)
    REFERENCES observer.observer_checkpoints(feed_id, statement_hash) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS observer_reports_feed_created_idx
  ON observer.observer_reports(feed_id, created_at);

DO $observer_v2_marker$
DECLARE marker_version integer;
BEGIN
  SELECT version INTO marker_version FROM observer.observer_schema_versions;
  IF marker_version = 1 THEN
    UPDATE observer.observer_schema_versions
      SET version = 2, schema_digest = current_setting('observer.schema_digest');
    EXECUTE 'ALTER TABLE observer.observer_schema_versions ADD CONSTRAINT observer_schema_versions_version_check CHECK (version = 2)';
  END IF;
END;
$observer_v2_marker$;

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

  SELECT catalog_fingerprint INTO stored_fingerprint FROM observer.observer_schema_versions WHERE version = 2;
  IF stored_fingerprint IS DISTINCT FROM actual_fingerprint THEN
    IF current_setting('observer.migrating_from_v1', true) = 'yes' THEN
      UPDATE observer.observer_schema_versions SET catalog_fingerprint = actual_fingerprint WHERE version = 2;
    ELSE
      RAISE EXCEPTION 'Observer schema catalog has changed';
    END IF;
  END IF;
END;
$observer_catalog$;
