CREATE TABLE "report"."InventorySnapshotBatch" (
  "id" UUID NOT NULL PRIMARY KEY,
  "localDate" TEXT NOT NULL,
  "warehouseId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "capturedAt" TIMESTAMPTZ(3) NOT NULL,
  "previousCapturedAt" TIMESTAMPTZ(3),
  CONSTRAINT "InventorySnapshotBatch_date_warehouse_key" UNIQUE ("localDate", "warehouseId")
);
CREATE INDEX "InventorySnapshotBatch_branchId_localDate_idx"
  ON "report"."InventorySnapshotBatch"("branchId", "localDate");

CREATE TABLE "report"."InventorySnapshot" (
  "localDate" TEXT NOT NULL,
  "warehouseId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "batchId" UUID NOT NULL,
  "sku" TEXT NOT NULL,
  "metalId" UUID NOT NULL,
  "metalCode" TEXT NOT NULL,
  "metalKind" TEXT NOT NULL,
  "onHand" INTEGER NOT NULL,
  "weight" DECIMAL(18,4) NOT NULL,
  "value" DECIMAL(20,2) NOT NULL,
  "received" INTEGER NOT NULL,
  "receivedWeight" DECIMAL(18,4) NOT NULL,
  "receivedValue" DECIMAL(20,2) NOT NULL,
  "released" INTEGER NOT NULL,
  "releasedWeight" DECIMAL(18,4) NOT NULL,
  "releasedValue" DECIMAL(20,2) NOT NULL,
  "sold" INTEGER NOT NULL,
  "soldWeight" DECIMAL(18,4) NOT NULL,
  "soldValue" DECIMAL(20,2) NOT NULL,
  CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("localDate", "warehouseId", "variantId"),
  CONSTRAINT "InventorySnapshot_batchId_fkey" FOREIGN KEY ("batchId")
    REFERENCES "report"."InventorySnapshotBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventorySnapshot_nonnegative_check" CHECK
    ("onHand" >= 0 AND "received" >= 0 AND "released" >= 0 AND "sold" >= 0)
);
CREATE INDEX "InventorySnapshot_metalId_localDate_idx"
  ON "report"."InventorySnapshot"("metalId", "localDate");
