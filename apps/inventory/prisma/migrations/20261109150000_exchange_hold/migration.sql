CREATE TYPE "inventory"."ExchangeHoldStatus" AS ENUM ('ACTIVE','PROTECTED','CONSUMED','EXPIRED','RELEASED');
CREATE TABLE "inventory"."ExchangeHold" (
  "exchangeId" uuid PRIMARY KEY,
  "branchId" uuid NOT NULL,
  "tagCode" text NOT NULL,
  "itemId" uuid NOT NULL REFERENCES "inventory"."JewelryItem"(id) ON DELETE RESTRICT,
  "variantId" uuid NOT NULL,
  "metalId" uuid NOT NULL,
  "productName" text NOT NULL,
  weight numeric(12,4) NOT NULL,
  "laborFee" numeric(15,2) NOT NULL,
  "metalSellPricePerChi" numeric(15,2) NOT NULL,
  price numeric(20,2) NOT NULL,
  "costPrice" numeric(15,2) NOT NULL,
  status "inventory"."ExchangeHoldStatus" NOT NULL,
  "expiresAt" timestamptz(3),
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT exchange_hold_values CHECK (weight>0 AND price>=0 AND "costPrice">=0 AND "metalSellPricePerChi">=0)
);
CREATE UNIQUE INDEX "ExchangeHold_one_live_item" ON "inventory"."ExchangeHold"("itemId") WHERE status IN ('ACTIVE','PROTECTED','CONSUMED');
CREATE INDEX "ExchangeHold_status_expiresAt_idx" ON "inventory"."ExchangeHold"(status,"expiresAt");
CREATE INDEX "ExchangeHold_itemId_status_idx" ON "inventory"."ExchangeHold"("itemId",status);
CREATE TABLE "inventory"."ExchangeOperation" (
  "exchangeId" uuid PRIMARY KEY,
  "releasedAt" timestamptz(3),
  "createdAt" timestamptz(3) NOT NULL DEFAULT now()
);
