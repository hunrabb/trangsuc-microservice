ALTER TABLE "inventory"."JewelryItem"
  ADD COLUMN "origin" "inventory"."ItemOrigin" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "sourceSettlementId" uuid,
  ADD COLUMN "sourceIntakeItemId" uuid,
  ADD COLUMN "sourceQuoteLineId" uuid,
  ADD COLUMN "purityPerMille" numeric(8,4);
ALTER TABLE "inventory"."GoodsReceipt"
  ADD COLUMN "source" "inventory"."ReceiptSource" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "sourceSettlementId" uuid,
  ADD COLUMN "sourceHash" text;
ALTER TABLE "inventory"."GoodsReceiptLine"
  ADD COLUMN "sourceIntakeItemId" uuid,
  ADD COLUMN "sourceQuoteLineId" uuid,
  ADD COLUMN "purityPerMille" numeric(8,4);

ALTER TABLE "inventory"."JewelryItem" ALTER COLUMN "costPrice" TYPE numeric(20,2);
ALTER TABLE "inventory"."GoodsReceiptLine" ALTER COLUMN "costPrice" TYPE numeric(20,2);
ALTER TABLE "inventory"."JewelryItem" DROP CONSTRAINT "JewelryItem_amounts_check";
ALTER TABLE "inventory"."GoodsReceiptLine" DROP CONSTRAINT "GoodsReceiptLine_amounts_check";

ALTER TABLE "inventory"."JewelryItem"
  ADD CONSTRAINT "JewelryItem_amounts_check" CHECK (
    "weight" > 0 AND "laborFee" >= 0 AND
    (("origin" = 'STANDARD' AND "costPrice" > 0) OR ("origin" = 'BOUGHT_BACK' AND "costPrice" >= 0))
  ),
  ADD CONSTRAINT "JewelryItem_buyback_source_check" CHECK (
    ("origin" = 'STANDARD' AND "status" <> 'PENDING_MELT'
      AND "sourceSettlementId" IS NULL AND "sourceIntakeItemId" IS NULL
      AND "sourceQuoteLineId" IS NULL AND "purityPerMille" IS NULL)
    OR ("origin" = 'BOUGHT_BACK' AND "status" = 'PENDING_MELT'
      AND "sourceSettlementId" IS NOT NULL AND "sourceIntakeItemId" IS NOT NULL
      AND "sourceQuoteLineId" IS NOT NULL AND "purityPerMille" IS NOT NULL
      AND "purityPerMille" > 0 AND "purityPerMille" <= 1000
      AND "laborFee" = 0 AND "orderId" IS NULL)
  );
ALTER TABLE "inventory"."GoodsReceipt"
  ADD CONSTRAINT "GoodsReceipt_buyback_source_check" CHECK (
    ("source" = 'STANDARD' AND "sourceSettlementId" IS NULL AND "sourceHash" IS NULL)
    OR ("source" = 'BUYBACK' AND "status" = 'APPROVED'
      AND "sourceSettlementId" IS NOT NULL AND "sourceHash" IS NOT NULL
      AND length("sourceHash") = 64)
  );
ALTER TABLE "inventory"."GoodsReceiptLine"
  ADD CONSTRAINT "GoodsReceiptLine_amounts_check" CHECK (
    "weight" > 0 AND "laborFee" >= 0 AND
    (("sourceQuoteLineId" IS NULL AND "costPrice" > 0)
      OR ("sourceQuoteLineId" IS NOT NULL AND "costPrice" >= 0))
  ),
  ADD CONSTRAINT "GoodsReceiptLine_buyback_source_check" CHECK (
    ("sourceQuoteLineId" IS NULL AND "sourceIntakeItemId" IS NULL AND "purityPerMille" IS NULL)
    OR ("sourceQuoteLineId" IS NOT NULL AND "sourceIntakeItemId" IS NOT NULL
      AND "purityPerMille" IS NOT NULL AND "purityPerMille" > 0 AND "purityPerMille" <= 1000)
  );

CREATE UNIQUE INDEX "GoodsReceipt_sourceSettlementId_key" ON "inventory"."GoodsReceipt"("sourceSettlementId");
CREATE UNIQUE INDEX "GoodsReceiptLine_sourceQuoteLineId_key" ON "inventory"."GoodsReceiptLine"("sourceQuoteLineId");
CREATE UNIQUE INDEX "JewelryItem_sourceQuoteLineId_key" ON "inventory"."JewelryItem"("sourceQuoteLineId");
CREATE UNIQUE INDEX "JewelryItem_sourceSettlementId_sourceIntakeItemId_key"
  ON "inventory"."JewelryItem"("sourceSettlementId", "sourceIntakeItemId");
CREATE INDEX "JewelryItem_origin_status_idx" ON "inventory"."JewelryItem"("origin", "status");
