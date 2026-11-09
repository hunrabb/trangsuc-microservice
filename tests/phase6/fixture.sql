-- Task 6.5B ONLY. Never executed in 6.5A. Fresh isolated test DB only.
-- No UPSERT/reset/truncate: an existing fixture fails rather than overwriting evidence.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'phase6_test' OR current_user <> 'inventory_user' THEN
    RAISE EXCEPTION 'Only isolated phase6_test as inventory_user';
  END IF;
END $$;
SET LOCAL search_path = inventory;
INSERT INTO "Category" (id,name) VALUES ('65000000-0000-4000-8000-000000000001','PH6ACCEPT Category');
INSERT INTO "Metal" (id,code,name,kind) VALUES ('65000000-0000-4000-8000-000000000002','PH6ACCEPT-GOLD','PH6ACCEPT Gold','GOLD');
INSERT INTO "MetalPrice" (id,"metalId","buyPrice","sellPrice","effectiveFrom","createdBy")
 VALUES ('65000000-0000-4000-8000-000000000008','65000000-0000-4000-8000-000000000002',1000000,2000000,clock_timestamp()-interval '1 second','65000000-0000-4000-8000-000000000009');
INSERT INTO "Product" (id,"categoryId",name,"publishedOnline")
 VALUES ('65000000-0000-4000-8000-000000000003','65000000-0000-4000-8000-000000000001','PH6ACCEPT Ring',true);
INSERT INTO "ProductVariant" (id,"productId","metalId",sku,name)
 VALUES ('65000000-0000-4000-8000-000000000004','65000000-0000-4000-8000-000000000003','65000000-0000-4000-8000-000000000002','PH6ACCEPT-SKU','PH6ACCEPT Variant');
INSERT INTO "Warehouse" (id,"branchId",name,"acceptsOnlineOrders")
 VALUES ('65000000-0000-4000-8000-000000000005','65000000-0000-4000-8000-000000000006','PH6ACCEPT Warehouse',true);
INSERT INTO "JewelryItem" (id,"variantId","warehouseId","tagCode",weight,"laborFee","costPrice")
 VALUES ('65000000-0000-4000-8000-000000000007','65000000-0000-4000-8000-000000000004','65000000-0000-4000-8000-000000000005','PH6ACCEPT-TAG',1.25,100000,1000000);
COMMIT;
