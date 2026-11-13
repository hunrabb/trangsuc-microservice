-- Chỉ đọc. Chạy trên DB legacy trước khi tách; kết quả mong đợi các cross_* = 0.
WITH owned AS (
  SELECT oid, nspname FROM pg_namespace
  WHERE nspname IN ('auth', 'inventory', 'sales', 'report')
)
SELECT 'cross_schema_foreign_keys' AS check_name, count(*) AS object_count
FROM pg_constraint c
JOIN pg_class source_table ON source_table.oid = c.conrelid
JOIN pg_class target_table ON target_table.oid = c.confrelid
WHERE c.contype = 'f'
  AND source_table.relnamespace IN (SELECT oid FROM owned)
  AND source_table.relnamespace <> target_table.relnamespace;

WITH owned AS (
  SELECT oid, nspname FROM pg_namespace
  WHERE nspname IN ('auth', 'inventory', 'sales', 'report')
)
SELECT 'cross_schema_trigger_functions' AS check_name, count(*) AS object_count
FROM pg_trigger t
JOIN pg_class table_rel ON table_rel.oid = t.tgrelid
JOIN pg_proc fn ON fn.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND table_rel.relnamespace IN (SELECT oid FROM owned)
  AND fn.pronamespace <> table_rel.relnamespace
  AND fn.pronamespace IN (SELECT oid FROM owned);

SELECT schemaname, count(*) AS table_count FROM pg_tables
WHERE schemaname IN ('auth', 'inventory', 'sales', 'report')
GROUP BY schemaname ORDER BY schemaname;

SELECT schemaname, viewname FROM pg_views
WHERE schemaname IN ('auth', 'inventory', 'sales', 'report')
ORDER BY schemaname, viewname;
