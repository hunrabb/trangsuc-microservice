CREATE TABLE "report"."OrderRevenue" (
  "orderId" UUID NOT NULL PRIMARY KEY,
  "branchId" UUID NOT NULL,
  "channel" TEXT NOT NULL,
  "localDate" TEXT NOT NULL,
  "paidAt" TIMESTAMPTZ(3),
  "revenue" DECIMAL(15,2) NOT NULL,
  "cogs" DECIMAL(15,2),
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderRevenue_status_check" CHECK ("status" IN ('PAID', 'CANCELLED')),
  CONSTRAINT "OrderRevenue_revenue_check" CHECK ("revenue" >= 0)
);
CREATE INDEX "OrderRevenue_localDate_branchId_status_idx"
  ON "report"."OrderRevenue"("localDate", "branchId", "status");

CREATE TABLE "report"."OrderLineSales" (
  "orderId" UUID NOT NULL,
  "tagCode" TEXT NOT NULL,
  "variantId" UUID,
  "metalId" UUID,
  "productName" TEXT NOT NULL,
  "metalWeight" DECIMAL(12,4) NOT NULL,
  "revenue" DECIMAL(15,2) NOT NULL,
  "cogs" DECIMAL(15,2),
  CONSTRAINT "OrderLineSales_pkey" PRIMARY KEY ("orderId", "tagCode"),
  CONSTRAINT "OrderLineSales_orderId_fkey" FOREIGN KEY ("orderId")
    REFERENCES "report"."OrderRevenue"("orderId") ON DELETE CASCADE,
  CONSTRAINT "OrderLineSales_revenue_check" CHECK ("revenue" >= 0)
);
CREATE INDEX "OrderLineSales_variantId_idx" ON "report"."OrderLineSales"("variantId");
CREATE INDEX "OrderLineSales_metalId_idx" ON "report"."OrderLineSales"("metalId");
