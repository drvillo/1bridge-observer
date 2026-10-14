-- Read-only fingerprint for an installed v1 or v2 observer schema.
SELECT md5(jsonb_build_object(
    'objects', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, object.relkind,
        object.relpersistence, object.relrowsecurity, object.relforcerowsecurity)
        ORDER BY object.relname)
      FROM pg_class AS object
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = current_schema() AND left(object.relname, 9) = 'observer_'
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
      WHERE namespace.nspname = current_schema() AND left(object.relname, 9) = 'observer_'
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
      WHERE namespace.nspname = current_schema() AND left(object.relname, 9) = 'observer_'
    ),
    'indexes', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, index_object.relname,
        pg_get_indexdef(index_entry.indexrelid)) ORDER BY object.relname, index_object.relname)
      FROM pg_index AS index_entry
      JOIN pg_class AS object ON object.oid = index_entry.indrelid
      JOIN pg_class AS index_object ON index_object.oid = index_entry.indexrelid
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = current_schema() AND left(object.relname, 9) = 'observer_'
    ),
    'triggers', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, trigger_entry.tgname,
        pg_get_triggerdef(trigger_entry.oid)) ORDER BY object.relname, trigger_entry.tgname)
      FROM pg_trigger AS trigger_entry
      JOIN pg_class AS object ON object.oid = trigger_entry.tgrelid
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = current_schema() AND left(object.relname, 9) = 'observer_'
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
      WHERE namespace.nspname = current_schema() AND left(object.relname, 9) = 'observer_'
    ),
    'sequences', (
      SELECT jsonb_agg(jsonb_build_array(object.relname, sequence_entry.seqtypid::regtype::text,
        sequence_entry.seqstart, sequence_entry.seqincrement, sequence_entry.seqmax,
        sequence_entry.seqmin, sequence_entry.seqcache, sequence_entry.seqcycle)
        ORDER BY object.relname)
      FROM pg_sequence AS sequence_entry
      JOIN pg_class AS object ON object.oid = sequence_entry.seqrelid
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = current_schema() AND left(object.relname, 9) = 'observer_'
    )
  )::text) AS catalog_fingerprint;
