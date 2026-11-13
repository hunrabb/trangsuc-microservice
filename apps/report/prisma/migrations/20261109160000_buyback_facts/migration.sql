CREATE TABLE "report"."BuybackSettlementFact" (
  "settlementId" uuid PRIMARY KEY,
  "intakeId" uuid NOT NULL,
  "quoteId" uuid NOT NULL,
  "branchId" uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('DIRECT','EXCHANGE')),
  "localDate" text NOT NULL,
  "settledAt" timestamptz(3) NOT NULL,
  "approvedAmount" numeric(20,2) NOT NULL CHECK ("approvedAmount" >= 0),
  "saleAmount" numeric(20,2),
  direction text NOT NULL CHECK (direction IN ('STORE_PAYS','CUSTOMER_PAYS','NONE')),
  "amountDue" numeric(20,2) NOT NULL CHECK ("amountDue" >= 0),
  "expectedItems" integer NOT NULL CHECK ("expectedItems" BETWEEN 1 AND 20),
  "snapshotHash" text NOT NULL CHECK (length("snapshotHash") = 64),
  snapshot jsonb NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX "BuybackSettlementFact_localDate_branchId_idx" ON "report"."BuybackSettlementFact"("localDate", "branchId");

CREATE TABLE "report"."BuybackStockFact" (
  "settlementId" uuid PRIMARY KEY,
  "branchId" uuid NOT NULL,
  "warehouseId" uuid NOT NULL,
  "receiptId" uuid NOT NULL UNIQUE,
  "localDate" text NOT NULL,
  "receivedAt" timestamptz(3) NOT NULL,
  "itemCount" integer NOT NULL CHECK ("itemCount" BETWEEN 1 AND 20),
  "costValue" numeric(20,2) NOT NULL CHECK ("costValue" >= 0),
  "snapshotHash" text NOT NULL CHECK (length("snapshotHash") = 64),
  snapshot jsonb NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX "BuybackStockFact_localDate_branchId_idx" ON "report"."BuybackStockFact"("localDate", "branchId");
