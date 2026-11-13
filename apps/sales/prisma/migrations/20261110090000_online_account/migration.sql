ALTER TABLE "sales"."OnlineOrder" ADD COLUMN "accountId" UUID;
CREATE INDEX "OnlineOrder_accountId_createdAt_id_idx" ON "sales"."OnlineOrder"("accountId", "createdAt", "id");
