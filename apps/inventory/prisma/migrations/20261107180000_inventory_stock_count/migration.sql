-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "StockCountLineStatus" AS ENUM ('EXPECTED', 'SCANNED', 'MISSING', 'MOVED');

-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'COUNT_MISSING';

-- CreateTable
CREATE TABLE "StockCount" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "createdBy" UUID NOT NULL,
    "closedBy" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" UUID NOT NULL,
    "stockCountId" UUID NOT NULL,
    "jewelryItemId" UUID NOT NULL,
    "tagCode" TEXT NOT NULL,
    "status" "StockCountLineStatus" NOT NULL DEFAULT 'EXPECTED',
    "scannedBy" UUID,
    "scannedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountExtra" (
    "id" UUID NOT NULL,
    "stockCountId" UUID NOT NULL,
    "tagCode" TEXT NOT NULL,
    "scannedBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCountExtra_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_code_key" ON "StockCount"("code");

-- CreateIndex
CREATE INDEX "StockCount_warehouseId_status_idx" ON "StockCount"("warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_stockCountId_tagCode_key" ON "StockCountLine"("stockCountId", "tagCode");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_stockCountId_jewelryItemId_key" ON "StockCountLine"("stockCountId", "jewelryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountExtra_stockCountId_tagCode_key" ON "StockCountExtra"("stockCountId", "tagCode");

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountExtra" ADD CONSTRAINT "StockCountExtra_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Mỗi kho tối đa một phiên kiểm kê đang mở (partial unique index, Prisma không sinh).
CREATE UNIQUE INDEX "StockCount_one_open_per_warehouse" ON "StockCount" ("warehouseId") WHERE "status" = 'OPEN';
-- Phiên đã đóng phải có người đóng và thời điểm đóng.
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_closed_check"
  CHECK ("status" <> 'CLOSED' OR ("closedBy" IS NOT NULL AND "closedAt" IS NOT NULL));
