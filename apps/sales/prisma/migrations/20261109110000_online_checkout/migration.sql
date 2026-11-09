CREATE TYPE "sales"."OnlineOrderStatus" AS ENUM ('PENDING','AWAITING_PAYMENT','CANCELLED');
CREATE TABLE "sales"."OnlineOrder" (
 "id" UUID NOT NULL PRIMARY KEY, "code" TEXT NOT NULL UNIQUE,
 "status" "sales"."OnlineOrderStatus" NOT NULL DEFAULT 'PENDING',
 "accessHash" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "requestedItems" JSONB NOT NULL,
 "recipientName" TEXT NOT NULL, "recipientPhone" TEXT NOT NULL, "shippingAddress" TEXT NOT NULL, "email" TEXT,
 "reservationId" UUID, "warehouseId" UUID, "branchId" UUID, "total" DECIMAL(20,2), "expiresAt" TIMESTAMPTZ(3),
 "deadlineAt" TIMESTAMPTZ(3) NOT NULL, "needsReview" BOOLEAN NOT NULL DEFAULT false,
 "recoveryAfter" TIMESTAMPTZ(3) NOT NULL, "failureCode" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "OnlineOrder_accessHash_idempotencyKey_key" UNIQUE ("accessHash","idempotencyKey"));
CREATE INDEX "OnlineOrder_status_recoveryAfter_idx" ON "sales"."OnlineOrder"("status","recoveryAfter");
CREATE TABLE "sales"."OnlineOrderItem" (
 "id" UUID NOT NULL PRIMARY KEY, "orderId" UUID NOT NULL REFERENCES "sales"."OnlineOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "jewelryItemId" UUID NOT NULL, "variantId" UUID NOT NULL, "sku" TEXT NOT NULL, "productName" TEXT NOT NULL,
 "price" DECIMAL(20,2) NOT NULL CHECK ("price" >= 0),
 CONSTRAINT "OnlineOrderItem_orderId_jewelryItemId_key" UNIQUE ("orderId","jewelryItemId"));
