-- Read-only assertions against the isolated Task 7.2 test database, never dev/prod.
DO $$ BEGIN
 IF current_database()<>'phase72_test' THEN RAISE EXCEPTION 'Only phase72_test'; END IF;
 IF (SELECT count(*) FROM sales._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>11 THEN RAISE EXCEPTION 'Sales migration count'; END IF;
 IF (SELECT count(*) FROM inventory._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>10 THEN RAISE EXCEPTION 'Inventory migration count'; END IF;
 IF EXISTS (SELECT "intakeId" FROM sales."BuybackQuote" WHERE status='APPROVED' GROUP BY "intakeId" HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate approved quote'; END IF;
 IF EXISTS (SELECT "intakeId" FROM sales."BuybackQuote" WHERE status='QUOTED' GROUP BY "intakeId" HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate current quote'; END IF;
 IF EXISTS (SELECT q.id FROM sales."BuybackQuote" q LEFT JOIN sales."BuybackQuoteLine" l ON l."quoteId"=q.id GROUP BY q.id HAVING count(l.id)=0 OR sum(l.amount)<>q.total) THEN RAISE EXCEPTION 'Invalid quote totals'; END IF;
 IF NOT EXISTS (SELECT FROM pg_indexes WHERE schemaname='sales' AND indexname='BuybackQuote_one_approved' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%') THEN RAISE EXCEPTION 'Missing unique approved index'; END IF;
 IF NOT EXISTS (SELECT FROM pg_indexes WHERE schemaname='sales' AND indexname='BuybackQuote_one_quoted' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%') THEN RAISE EXCEPTION 'Missing unique current quote index'; END IF;
 IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='BuybackIntake_activeQuote_fkey' AND contype='f') THEN RAISE EXCEPTION 'Missing active quote ownership FK'; END IF;
 IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema='sales' AND table_name='BuybackQuote' AND column_name='total' AND numeric_precision=20 AND numeric_scale=2 AND is_nullable='NO') THEN RAISE EXCEPTION 'Total precision'; END IF;
 IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema='sales' AND table_name='BuybackAppraisal' AND column_name='acceptedWeight' AND numeric_precision=12 AND numeric_scale=4 AND is_nullable='NO') THEN RAISE EXCEPTION 'Weight precision'; END IF;
 IF EXISTS (SELECT FROM sales."BuybackIntake" WHERE code LIKE 'PH72-COMPAT-%' AND "activeQuoteId" IS NOT NULL) THEN RAISE EXCEPTION 'Old fixture changed'; END IF;
END $$;
SELECT 'sales' AS service,migration_name,checksum FROM sales._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL UNION ALL SELECT 'inventory',migration_name,checksum FROM inventory._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1,2;
SELECT conname,contype,pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='sales'::regnamespace AND conrelid::regclass::text LIKE '%Buyback%' ORDER BY conname;
SELECT tgname,tgdeferrable,tginitdeferred FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='sales'::regnamespace AND relname LIKE 'Buyback%') ORDER BY tgname;
