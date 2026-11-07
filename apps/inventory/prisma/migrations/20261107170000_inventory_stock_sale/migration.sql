-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MovementType" ADD VALUE 'SALE';
ALTER TYPE "MovementType" ADD VALUE 'RELEASE';

-- AlterTable
ALTER TABLE "JewelryItem" ADD COLUMN     "metalPriceAtSale" DECIMAL(15,2),
ADD COLUMN     "orderId" UUID,
ADD COLUMN     "priceAtSale" DECIMAL(15,2),
ADD COLUMN     "soldAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "StockMovement" ALTER COLUMN "createdBy" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "JewelryItem_orderId_idx" ON "JewelryItem"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_refType_refId_jewelryItemId_type_key" ON "StockMovement"("refType", "refId", "jewelryItemId", "type");


-- Chiếc đã bán phải có đơn, chiếc chưa bán không được có đơn và giá chốt.
ALTER TABLE "JewelryItem" ADD CONSTRAINT "JewelryItem_sold_order_check"
  CHECK (("status" = 'SOLD') = ("orderId" IS NOT NULL));
ALTER TABLE "JewelryItem" ADD CONSTRAINT "JewelryItem_sale_snapshot_check"
  CHECK (("orderId" IS NOT NULL) OR ("soldAt" IS NULL AND "metalPriceAtSale" IS NULL AND "priceAtSale" IS NULL));
