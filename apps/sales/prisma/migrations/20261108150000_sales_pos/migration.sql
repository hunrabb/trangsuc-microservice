-- Một migration cho lõi POS, tương thích các bảng outbox đang có.
CREATE TYPE "OrderStatus" AS ENUM ('CREATING', 'PENDING_PAYMENT', 'COMPLETED', 'CANCELLING', 'CANCELLED');

CREATE TABLE "Order" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "branchId" UUID NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'CREATING',
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "requestedTagCodes" TEXT[] NOT NULL,
  "total" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" UUID NOT NULL,
  "operationOwner" UUID,
  "operationUntil" TIMESTAMPTZ(3),
  "deductionStarted" BOOLEAN NOT NULL DEFAULT false,
  "failureCode" TEXT,
  "failureHttpStatus" INTEGER,
  "failedTagCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Order_total_nonnegative" CHECK ("total" >= 0),
  CONSTRAINT "Order_version_positive" CHECK ("version" > 0),
  CONSTRAINT "Order_tags_nonempty" CHECK (cardinality("requestedTagCodes") > 0)
);

CREATE TABLE "OrderItem" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "jewelryItemId" UUID NOT NULL,
  "tagCode" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "metalWeight" DECIMAL(12,4) NOT NULL,
  "laborFee" DECIMAL(15,2) NOT NULL,
  "stoneFee" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "metalPriceAtSale" DECIMAL(15,2) NOT NULL,
  "price" DECIMAL(15,2) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderItem_weight_positive" CHECK ("metalWeight" > 0),
  CONSTRAINT "OrderItem_money_nonnegative" CHECK (
    "laborFee" >= 0 AND "stoneFee" >= 0 AND "metalPriceAtSale" >= 0 AND "price" >= 0
  )
);

CREATE TABLE "OrderStatusHistory" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "fromStatus" "OrderStatus",
  "toStatus" "OrderStatus" NOT NULL,
  "changedBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "AuditLog" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "orderId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Order_code_key" ON "Order"("code");
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");
CREATE INDEX "Order_branchId_createdAt_idx" ON "Order"("branchId", "createdAt");
CREATE UNIQUE INDEX "OrderItem_orderId_tagCode_key" ON "OrderItem"("orderId", "tagCode");
CREATE INDEX "OrderStatusHistory_orderId_createdAt_idx" ON "OrderStatusHistory"("orderId", "createdAt");
CREATE INDEX "AuditLog_orderId_idx" ON "AuditLog"("orderId");
