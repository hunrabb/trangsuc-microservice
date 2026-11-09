CREATE TYPE "inventory"."ReservationStatus" AS ENUM ('ACTIVE','RELEASED','EXPIRED','FAILED','PAYMENT_REVIEW','CONSUMED');
CREATE TABLE "inventory"."StockReservation" (
 "id" UUID NOT NULL PRIMARY KEY, "orderId" UUID NOT NULL UNIQUE, "requestHash" TEXT,
 "status" "inventory"."ReservationStatus" NOT NULL, "warehouseId" UUID, "branchId" UUID,
 "expiresAt" TIMESTAMPTZ(3), "total" DECIMAL(20,2) NOT NULL DEFAULT 0, "failureCode" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "StockReservation_active_fields" CHECK ("status" <> 'ACTIVE' OR ("expiresAt" IS NOT NULL AND "warehouseId" IS NOT NULL AND "branchId" IS NOT NULL)));
CREATE INDEX "StockReservation_status_expiresAt_idx" ON "inventory"."StockReservation"("status","expiresAt");
CREATE TABLE "inventory"."StockReservationItem" (
 "id" UUID NOT NULL PRIMARY KEY, "reservationId" UUID NOT NULL REFERENCES "inventory"."StockReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "jewelryItemId" UUID NOT NULL REFERENCES "inventory"."JewelryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "variantId" UUID NOT NULL, "sku" TEXT NOT NULL, "productName" TEXT NOT NULL,
 "price" DECIMAL(20,2) NOT NULL CHECK ("price" >= 0), "isActive" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "StockReservationItem_reservationId_jewelryItemId_key" UNIQUE ("reservationId","jewelryItemId"));
-- DB bảo vệ một chiếc chỉ có một lượt giữ active, bên cạnh conditional item status update.
CREATE UNIQUE INDEX "StockReservationItem_one_active_item" ON "inventory"."StockReservationItem"("jewelryItemId") WHERE "isActive";
