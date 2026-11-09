ALTER TABLE "sales"."OrderItem"
  ADD COLUMN "costPrice" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN "variantId" UUID,
  ADD COLUMN "metalId" UUID;
