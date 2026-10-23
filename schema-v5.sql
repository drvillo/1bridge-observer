-- Compact global registry witness. Legacy v1 rows remain historical.
SELECT set_config('search_path', 'observer', true);

CREATE TABLE observer.observer_witness_cursor (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  publisher_key_id text NOT NULL CHECK (publisher_key_id ~ '^[0-9a-f]{64}$'),
  genesis_hash text NOT NULL CHECK (genesis_hash ~ '^[0-9a-f]{64}$'),
  signed_genesis bytea NOT NULL,
  accepted_hash text NOT NULL CHECK (accepted_hash ~ '^[0-9a-f]{64}$'),
  accepted_size bigint NOT NULL CHECK (accepted_size BETWEEN 0 AND 9007199254740991),
  signed_accepted bytea NOT NULL,
  version bigint NOT NULL DEFAULT 0
);

CREATE TABLE observer.observer_witness_reports (
  report_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_hash text NOT NULL UNIQUE CHECK (report_hash ~ '^[0-9a-f]{64}$'),
  accepted_hash text NOT NULL CHECK (accepted_hash ~ '^[0-9a-f]{64}$'),
  signed_report bytea NOT NULL,
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE observer.observer_witness_findings (
  finding_hash text PRIMARY KEY CHECK (finding_hash ~ '^[0-9a-f]{64}$'),
  finding_kind text NOT NULL,
  target_hash text CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  evidence_bytes bytea NOT NULL CHECK (octet_length(evidence_bytes) BETWEEN 1 AND 98304),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz
);

ALTER TABLE observer.observer_schema_versions DROP CONSTRAINT observer_schema_versions_version_check;
UPDATE observer.observer_schema_versions
  SET version = 5, schema_digest = current_setting('observer.schema_digest');
ALTER TABLE observer.observer_schema_versions
  ADD CONSTRAINT observer_schema_versions_version_check CHECK (version = 5);
