ALTER TABLE "inventory"."Product" ADD COLUMN "publishedOnline" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "imageUrl" TEXT, ADD COLUMN "catalogVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory"."Warehouse" ADD COLUMN "acceptsOnlineOrders" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "inventory"."OnlineStockBuffer" ("warehouseId" UUID NOT NULL REFERENCES "inventory"."Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "variantId" UUID NOT NULL REFERENCES "inventory"."ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE, "quantity" INTEGER NOT NULL DEFAULT 0 CHECK ("quantity" >= 0),
 PRIMARY KEY ("warehouseId", "variantId"));
