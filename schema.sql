-- Observer schema v1. The caller MUST execute this entire file within one
-- transaction after SET LOCAL observer.schema_digest to the lowercase SHA-256
-- digest of this exact file. Use a dedicated database or selected schema.
SELECT pg_advisory_xact_lock(6704462056185601401);

DO $observer_install$
DECLARE
  marker_exists boolean := to_regclass(format('%I.observer_schema_versions', current_schema())) IS NOT NULL;
  marker_count integer;
  marker_version integer;
  marker_digest text;
  table_count integer;
  expected_digest text := current_setting('observer.schema_digest', true);
BEGIN
  IF expected_digest IS NULL OR expected_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Missing or malformed observer schema digest';
  END IF;
  IF NOT marker_exists THEN
    IF EXISTS (
      SELECT 1 FROM pg_class AS object
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = current_schema()
        AND left(object.relname, 9) = 'observer_'
    ) THEN
      RAISE EXCEPTION 'Observer object collision before schema installation';
    END IF;
  ELSE
    SELECT count(*), min(version), min(schema_digest)
      INTO marker_count, marker_version, marker_digest
      FROM observer_schema_versions;
    IF marker_count <> 1 OR marker_version <> 1 OR marker_digest <> expected_digest THEN
      RAISE EXCEPTION 'Unsupported observer schema marker';
    END IF;
    SELECT count(*) INTO table_count
      FROM pg_class AS object
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = current_schema()
        AND object.relkind IN ('r', 'p')
        AND object.relname IN (
          'observer_schema_versions', 'observer_feeds', 'observer_cursors',
          'observer_targets', 'observer_leaves', 'observer_checkpoints',
          'observer_staged_leaves', 'observer_staged_checkpoints', 'observer_findings'
        );
    IF table_count <> 9 THEN
      RAISE EXCEPTION 'Incomplete observer schema';
    END IF;
  END IF;
END;
$observer_install$;

CREATE TABLE IF NOT EXISTS observer_schema_versions (
  version integer PRIMARY KEY CHECK (version = 1),
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[0-9a-f]{64}$'),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS observer_feeds (
  feed_id text PRIMARY KEY CHECK (feed_id ~ '^[0-9a-f]{64}$'),
  anchor_pin text NOT NULL CHECK (anchor_pin ~ '^[0-9a-f]{64}$'),
  signed_anchor bytea NOT NULL CHECK (octet_length(signed_anchor) > 0),
  source_base_url text NOT NULL CHECK (length(source_base_url) BETWEEN 1 AND 2048),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS observer_targets (
  feed_id text NOT NULL REFERENCES observer_feeds(feed_id) ON DELETE RESTRICT,
  attempt_id bigint GENERATED ALWAYS AS IDENTITY,
  target_hash text NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  target_size bigint NOT NULL CHECK (target_size BETWEEN 0 AND 9007199254740991),
  signed_checkpoint bytea NOT NULL CHECK (octet_length(signed_checkpoint) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'accepted', 'quarantined')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (feed_id, attempt_id),
  CHECK ((status = 'active' AND finished_at IS NULL) OR (status <> 'active' AND finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS observer_targets_one_active_idx
  ON observer_targets(feed_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS observer_targets_feed_created_idx
  ON observer_targets(feed_id, created_at);

CREATE TABLE IF NOT EXISTS observer_leaves (
  feed_id text NOT NULL REFERENCES observer_feeds(feed_id) ON DELETE RESTRICT,
  leaf_index bigint NOT NULL CHECK (leaf_index BETWEEN 0 AND 9007199254740991),
  leaf_hash text NOT NULL CHECK (leaf_hash ~ '^[0-9a-f]{64}$'),
  leaf_bytes bytea NOT NULL CHECK (octet_length(leaf_bytes) > 0),
  PRIMARY KEY (feed_id, leaf_index)
);

CREATE TABLE IF NOT EXISTS observer_checkpoints (
  feed_id text NOT NULL REFERENCES observer_feeds(feed_id) ON DELETE RESTRICT,
  statement_hash text NOT NULL CHECK (statement_hash ~ '^[0-9a-f]{64}$'),
  position bigint NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  checkpoint_size bigint NOT NULL CHECK (checkpoint_size BETWEEN 0 AND 9007199254740991),
  previous_hash text CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  signed_checkpoint bytea NOT NULL CHECK (octet_length(signed_checkpoint) > 0),
  PRIMARY KEY (feed_id, statement_hash),
  UNIQUE (feed_id, position),
  CHECK ((position = 0) = (previous_hash IS NULL))
);
CREATE INDEX IF NOT EXISTS observer_checkpoints_feed_size_idx
  ON observer_checkpoints(feed_id, checkpoint_size);

CREATE TABLE IF NOT EXISTS observer_staged_leaves (
  feed_id text NOT NULL,
  attempt_id bigint NOT NULL,
  leaf_index bigint NOT NULL CHECK (leaf_index BETWEEN 0 AND 9007199254740991),
  leaf_hash text NOT NULL CHECK (leaf_hash ~ '^[0-9a-f]{64}$'),
  leaf_bytes bytea NOT NULL CHECK (octet_length(leaf_bytes) > 0),
  PRIMARY KEY (feed_id, attempt_id, leaf_index),
  FOREIGN KEY (feed_id, attempt_id) REFERENCES observer_targets(feed_id, attempt_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS observer_staged_checkpoints (
  feed_id text NOT NULL,
  attempt_id bigint NOT NULL,
  position bigint NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  statement_hash text NOT NULL CHECK (statement_hash ~ '^[0-9a-f]{64}$'),
  checkpoint_size bigint NOT NULL CHECK (checkpoint_size BETWEEN 0 AND 9007199254740991),
  previous_hash text CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  signed_checkpoint bytea NOT NULL CHECK (octet_length(signed_checkpoint) > 0),
  PRIMARY KEY (feed_id, attempt_id, position),
  UNIQUE (feed_id, attempt_id, statement_hash),
  FOREIGN KEY (feed_id, attempt_id) REFERENCES observer_targets(feed_id, attempt_id) ON DELETE RESTRICT,
  CHECK ((position = 0) = (previous_hash IS NULL))
);
CREATE INDEX IF NOT EXISTS observer_staged_checkpoints_feed_size_idx
  ON observer_staged_checkpoints(feed_id, attempt_id, checkpoint_size);

CREATE TABLE IF NOT EXISTS observer_cursors (
  feed_id text PRIMARY KEY REFERENCES observer_feeds(feed_id) ON DELETE RESTRICT,
  staged_next_index bigint NOT NULL DEFAULT 0 CHECK (staged_next_index BETWEEN 0 AND 9007199254740991),
  accepted_size bigint NOT NULL DEFAULT 0 CHECK (accepted_size BETWEEN 0 AND 9007199254740991),
  accepted_checkpoint_hash text CHECK (accepted_checkpoint_hash ~ '^[0-9a-f]{64}$'),
  active_attempt_id bigint,
  staged_checkpoint_tail_hash text CHECK (staged_checkpoint_tail_hash ~ '^[0-9a-f]{64}$'),
  staged_checkpoint_tail_position bigint CHECK (staged_checkpoint_tail_position BETWEEN 0 AND 9007199254740991),
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch BETWEEN 0 AND 9007199254740991),
  lease_owner text CHECK (length(lease_owner) BETWEEN 1 AND 256),
  lease_until timestamptz,
  FOREIGN KEY (feed_id, active_attempt_id) REFERENCES observer_targets(feed_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (feed_id, accepted_checkpoint_hash) REFERENCES observer_checkpoints(feed_id, statement_hash) ON DELETE RESTRICT,
  FOREIGN KEY (feed_id, active_attempt_id, staged_checkpoint_tail_hash)
    REFERENCES observer_staged_checkpoints(feed_id, attempt_id, statement_hash) ON DELETE RESTRICT,
  CHECK (staged_next_index >= accepted_size),
  CHECK (accepted_size = 0 OR accepted_checkpoint_hash IS NOT NULL),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((staged_checkpoint_tail_hash IS NULL) = (staged_checkpoint_tail_position IS NULL)),
  CHECK (active_attempt_id IS NOT NULL OR (staged_next_index = accepted_size AND staged_checkpoint_tail_hash IS NULL))
);

CREATE TABLE IF NOT EXISTS observer_findings (
  finding_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feed_id text NOT NULL REFERENCES observer_feeds(feed_id) ON DELETE RESTRICT,
  attempt_id bigint,
  finding_type text NOT NULL CHECK (length(finding_type) BETWEEN 1 AND 128),
  evidence_bytes bytea NOT NULL CHECK (octet_length(evidence_bytes) > 0),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  FOREIGN KEY (feed_id, attempt_id) REFERENCES observer_targets(feed_id, attempt_id) ON DELETE RESTRICT,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (resolved_at IS NULL OR resolved_at >= first_seen_at)
);
CREATE INDEX IF NOT EXISTS observer_findings_unresolved_idx
  ON observer_findings(feed_id, first_seen_at) WHERE resolved_at IS NULL;

INSERT INTO observer_schema_versions(version, schema_digest)
  VALUES (1, current_setting('observer.schema_digest')) ON CONFLICT (version) DO NOTHING;
