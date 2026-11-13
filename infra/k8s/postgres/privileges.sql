-- Application roles may connect only to their own logical database.
-- Preserve CNPG replication/metrics access to postgres explicitly.
\connect postgres
BEGIN;
REVOKE CONNECT ON DATABASE postgres, template0, template1 FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO streaming_replica, cnpg_metrics_exporter;
COMMIT;

-- Demo jewelry-pg only. DatabaseRole/Database CRDs own roles, DB/schema ownership.
-- This file owns ACL/default privileges only. Apply as local demo admin after CRDs reconcile.
\connect auth_db
BEGIN;
REVOKE ALL ON DATABASE auth_db FROM PUBLIC;
GRANT CONNECT ON DATABASE auth_db TO auth_migrator, auth_user;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO auth_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO auth_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA auth TO auth_user;
ALTER DEFAULT PRIVILEGES FOR ROLE auth_migrator IN SCHEMA auth GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_user;
ALTER DEFAULT PRIVILEGES FOR ROLE auth_migrator IN SCHEMA auth GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO auth_user;
DO $acl$
BEGIN
  IF to_regclass('auth._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE auth._prisma_migrations FROM auth_user';
  END IF;
END $acl$;
COMMIT;

\connect inventory_db
BEGIN;
REVOKE ALL ON DATABASE inventory_db FROM PUBLIC;
GRANT CONNECT ON DATABASE inventory_db TO inventory_migrator, inventory_user;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA inventory TO inventory_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA inventory TO inventory_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA inventory TO inventory_user;
ALTER DEFAULT PRIVILEGES FOR ROLE inventory_migrator IN SCHEMA inventory GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO inventory_user;
ALTER DEFAULT PRIVILEGES FOR ROLE inventory_migrator IN SCHEMA inventory GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO inventory_user;
DO $acl$
BEGIN
  IF to_regclass('inventory._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE inventory._prisma_migrations FROM inventory_user';
  END IF;
END $acl$;
COMMIT;

\connect sales_db
BEGIN;
REVOKE ALL ON DATABASE sales_db FROM PUBLIC;
GRANT CONNECT ON DATABASE sales_db TO sales_migrator, sales_user;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA sales TO sales_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sales TO sales_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA sales TO sales_user;
ALTER DEFAULT PRIVILEGES FOR ROLE sales_migrator IN SCHEMA sales GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sales_user;
ALTER DEFAULT PRIVILEGES FOR ROLE sales_migrator IN SCHEMA sales GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO sales_user;
DO $acl$
BEGIN
  IF to_regclass('sales._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE sales._prisma_migrations FROM sales_user';
  END IF;
END $acl$;
COMMIT;

\connect report_db
BEGIN;
REVOKE ALL ON DATABASE report_db FROM PUBLIC;
GRANT CONNECT ON DATABASE report_db TO report_migrator, report_user;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA report TO report_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA report TO report_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA report TO report_user;
ALTER DEFAULT PRIVILEGES FOR ROLE report_migrator IN SCHEMA report GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO report_user;
ALTER DEFAULT PRIVILEGES FOR ROLE report_migrator IN SCHEMA report GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO report_user;
DO $acl$
BEGIN
  IF to_regclass('report._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE report._prisma_migrations FROM report_user';
  END IF;
END $acl$;
COMMIT;
