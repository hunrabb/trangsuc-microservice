CREATE TABLE "report"."DeferredStockEvent" (
  "eventId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "tagCodes" TEXT[] NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeferredStockEvent_pkey" PRIMARY KEY ("eventId")
);
CREATE INDEX "DeferredStockEvent_branchId_occurredAt_idx"
  ON "report"."DeferredStockEvent"("branchId", "occurredAt");
