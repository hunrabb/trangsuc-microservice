-- Mỗi orderId có một dòng để deduct/release khoá cùng một điểm trong Postgres.
-- release không thấy chiếc SOLD vẫn lưu releasedAt, chặn deduct đến muộn sau timeout.
CREATE TABLE "StockOrderOperation" (
  "orderId" UUID NOT NULL,
  "releasedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockOrderOperation_pkey" PRIMARY KEY ("orderId")
);
