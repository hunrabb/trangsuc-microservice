ALTER TABLE "inventory"."StockMovement" ALTER COLUMN "createdAt" SET DEFAULT clock_timestamp();
CREATE INDEX "StockMovement_warehouseId_createdAt_idx" ON "inventory"."StockMovement"("warehouseId", "createdAt");

CREATE TABLE "inventory"."InventoryDailyClose" (
  "id" UUID NOT NULL PRIMARY KEY,
  "localDate" TEXT NOT NULL,
  "warehouseId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "capturedAt" TIMESTAMPTZ(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryDailyClose_warehouseId_fkey" FOREIGN KEY ("warehouseId")
    REFERENCES "inventory"."Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InventoryDailyClose_localDate_warehouseId_key"
  ON "inventory"."InventoryDailyClose"("localDate", "warehouseId");
CREATE INDEX "InventoryDailyClose_branchId_localDate_idx"
  ON "inventory"."InventoryDailyClose"("branchId", "localDate");
