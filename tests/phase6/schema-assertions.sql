-- Read-only acceptance inspection. Run only inside verified acceptance PostgreSQL.
DO $$ BEGIN
 IF current_database() <> 'phase6_test' THEN RAISE EXCEPTION 'Only phase6_test'; END IF;
 IF (SELECT count(*) FROM inventory._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> 10 THEN RAISE EXCEPTION 'Inventory migration count'; END IF;
 IF (SELECT count(*) FROM sales._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> 9 THEN RAISE EXCEPTION 'Sales Phase 6 migration count'; END IF;
 IF NOT EXISTS (SELECT FROM pg_indexes WHERE schemaname='inventory' AND indexname='StockReservationItem_one_active_item' AND indexdef LIKE '%WHERE "isActive"%') THEN RAISE EXCEPTION 'Missing active item partial unique'; END IF;
 IF EXISTS (SELECT "jewelryItemId" FROM inventory."StockReservationItem" WHERE "isActive" GROUP BY "jewelryItemId" HAVING count(*)>1) THEN RAISE EXCEPTION 'Multiple active owners'; END IF;
 IF EXISTS (SELECT "bankTxnRef" FROM sales."OnlinePayment" GROUP BY "bankTxnRef" HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate bank reference'; END IF;
 IF EXISTS (SELECT FROM information_schema.columns WHERE table_schema IN ('inventory','sales') AND table_name IN ('StockReservationItem','OnlineOrderItem','OnlinePayment') AND column_name IN ('price','amount') AND (numeric_precision<>20 OR numeric_scale<>2 OR is_nullable<>'NO')) THEN RAISE EXCEPTION 'Money precision/nullability'; END IF;
END $$;
SELECT schemaname,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('inventory','sales') AND (indexname LIKE 'StockReservation%' OR indexname LIKE 'OnlinePayment%' OR indexname LIKE 'OnlineOrder%') ORDER BY 1,2;
SELECT n.nspname,t.relname,c.conname,pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON c.conrelid=t.oid JOIN pg_namespace n ON t.relnamespace=n.oid WHERE n.nspname IN ('inventory','sales') AND t.relname IN ('StockReservation','StockReservationItem','OnlinePayment','OnlinePaymentRequest','OnlineOrder','OnlineOrderItem') ORDER BY 1,2,3;
SELECT 'inventory' AS service,migration_name,checksum,finished_at IS NOT NULL AS applied FROM inventory._prisma_migrations UNION ALL SELECT 'sales',migration_name,checksum,finished_at IS NOT NULL FROM sales._prisma_migrations ORDER BY 1,2;
