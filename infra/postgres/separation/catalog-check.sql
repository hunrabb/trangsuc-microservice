-- Chỉ đọc. Đối chiếu metadata PostgreSQL, ngoài dữ liệu bảng.
SELECT n.nspname AS schema_name,
  (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p')) AS tables,
  (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('i', 'I')) AS indexes,
  (SELECT count(*) FROM pg_constraint c WHERE c.connamespace = n.oid) AS constraints,
  (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = n.oid) AS routines,
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = n.oid AND NOT t.tgisinternal) AS triggers,
  (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind = 'S') AS sequences
FROM pg_namespace n
WHERE n.nspname IN ('auth', 'inventory', 'sales', 'report')
ORDER BY n.nspname;
