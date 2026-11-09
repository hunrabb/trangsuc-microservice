ALTER TYPE "sales"."OnlineOrderStatus" ADD VALUE 'PAYMENT_PROCESSING';
ALTER TYPE "sales"."OnlineOrderStatus" ADD VALUE 'CONFIRMED';
ALTER TYPE "sales"."OnlineOrderStatus" ADD VALUE 'PAYMENT_REVIEW';
ALTER TYPE "sales"."OnlineOrderStatus" ADD VALUE 'REFUND_PENDING';
ALTER TABLE "sales"."OnlineOrder" ADD COLUMN "activePaymentId" UUID, ADD COLUMN "paymentAttempts" INTEGER NOT NULL DEFAULT 0;
CREATE TYPE "sales"."OnlinePaymentStatus" AS ENUM ('RECEIVED','INVENTORY_CONFIRMED','RECONCILIATION_REQUIRED','REFUND_PENDING');
CREATE TABLE "sales"."OnlinePayment" (
 "id" UUID PRIMARY KEY, "orderId" UUID NOT NULL REFERENCES "sales"."OnlineOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "inventoryVersion" INTEGER NOT NULL DEFAULT 0, "bankTxnRef" TEXT NOT NULL UNIQUE, "amount" DECIMAL(20,2) NOT NULL CHECK ("amount" > 0),
 "currency" TEXT NOT NULL DEFAULT 'VND' CHECK ("currency" = 'VND'), "evidenceRef" TEXT NOT NULL,
 "actorId" UUID NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
 "status" "sales"."OnlinePaymentStatus" NOT NULL, "receivedAt" TIMESTAMPTZ(3) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "OnlinePayment_actorId_idempotencyKey_key" UNIQUE ("actorId","idempotencyKey"));
CREATE INDEX "OnlinePayment_orderId_createdAt_idx" ON "sales"."OnlinePayment"("orderId","createdAt");
CREATE TABLE "sales"."OnlinePaymentAudit" (
 "id" UUID PRIMARY KEY, "orderId" UUID NOT NULL REFERENCES "sales"."OnlineOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "paymentId" UUID, "actorId" UUID, "action" TEXT NOT NULL, "fromStatus" TEXT NOT NULL, "toStatus" TEXT NOT NULL, "reason" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "OnlinePaymentAudit_orderId_createdAt_idx" ON "sales"."OnlinePaymentAudit"("orderId","createdAt");

CREATE TABLE "sales"."OnlinePaymentRequest" (
 "id" UUID PRIMARY KEY, "actorId" UUID NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
 "paymentId" UUID NOT NULL REFERENCES "sales"."OnlinePayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "OnlinePaymentRequest_actorId_idempotencyKey_key" UNIQUE ("actorId","idempotencyKey"));
