-- Worker chỉ quét đơn dở theo updatedAt; index này không chứa lịch sử đơn đã hoàn tất.
CREATE INDEX "Order_recovery_updatedAt_idx"
  ON "sales"."Order" ("updatedAt")
  WHERE "status" IN ('CREATING', 'CANCELLING');
