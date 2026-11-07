-- CreateEnum
CREATE TYPE "MetalKind" AS ENUM ('GOLD', 'SILVER');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('IN_STOCK', 'RESERVED', 'SOLD');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('DRAFT', 'APPROVED');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('RECEIPT');

-- CreateTable
CREATE TABLE "Metal" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "MetalKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Metal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetalPrice" (
    "id" UUID NOT NULL,
    "metalId" UUID NOT NULL,
    "buyPrice" DECIMAL(15,2) NOT NULL,
    "sellPrice" DECIMAL(15,2) NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetalPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "metalId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultLaborFee" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JewelryItem" (
    "id" UUID NOT NULL,
    "tagCode" TEXT NOT NULL,
    "variantId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "weight" DECIMAL(12,4) NOT NULL,
    "laborFee" DECIMAL(15,2) NOT NULL,
    "costPrice" DECIMAL(15,2) NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'IN_STOCK',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JewelryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdBy" UUID NOT NULL,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "tagCode" TEXT NOT NULL,
    "weight" DECIMAL(12,4) NOT NULL,
    "laborFee" DECIMAL(15,2) NOT NULL,
    "costPrice" DECIMAL(15,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "jewelryItemId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "type" "MovementType" NOT NULL,
    "toStatus" "ItemStatus" NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Metal_code_key" ON "Metal"("code");

-- CreateIndex
CREATE INDEX "MetalPrice_metalId_effectiveFrom_idx" ON "MetalPrice"("metalId", "effectiveFrom" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE INDEX "ProductVariant_metalId_idx" ON "ProductVariant"("metalId");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_branchId_key" ON "Warehouse"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "JewelryItem_tagCode_key" ON "JewelryItem"("tagCode");

-- CreateIndex
CREATE INDEX "JewelryItem_warehouseId_status_idx" ON "JewelryItem"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "JewelryItem_variantId_idx" ON "JewelryItem"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_code_key" ON "GoodsReceipt"("code");

-- CreateIndex
CREATE INDEX "GoodsReceipt_warehouseId_status_idx" ON "GoodsReceipt"("warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptLine_receiptId_tagCode_key" ON "GoodsReceiptLine"("receiptId", "tagCode");

-- CreateIndex
CREATE INDEX "StockMovement_jewelryItemId_idx" ON "StockMovement"("jewelryItemId");

-- CreateIndex
CREATE INDEX "StockMovement_refType_refId_idx" ON "StockMovement"("refType", "refId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "MetalPrice" ADD CONSTRAINT "MetalPrice_metalId_fkey" FOREIGN KEY ("metalId") REFERENCES "Metal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_metalId_fkey" FOREIGN KEY ("metalId") REFERENCES "Metal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JewelryItem" ADD CONSTRAINT "JewelryItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JewelryItem" ADD CONSTRAINT "JewelryItem_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_jewelryItemId_fkey" FOREIGN KEY ("jewelryItemId") REFERENCES "JewelryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CHECK viết tay (Prisma không sinh): trọng lượng và tiền không âm / dương.
ALTER TABLE "MetalPrice" ADD CONSTRAINT "MetalPrice_prices_check" CHECK ("buyPrice" > 0 AND "sellPrice" > 0);
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_labor_check" CHECK ("defaultLaborFee" >= 0);
ALTER TABLE "JewelryItem" ADD CONSTRAINT "JewelryItem_amounts_check" CHECK ("weight" > 0 AND "laborFee" >= 0 AND "costPrice" > 0);
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_amounts_check" CHECK ("weight" > 0 AND "laborFee" >= 0 AND "costPrice" > 0);
-- Phiếu đã duyệt phải có người duyệt và thời điểm duyệt.
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_approved_check" CHECK ("status" <> 'APPROVED' OR ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL));
