ALTER TYPE "inventory"."ItemStatus" ADD VALUE IF NOT EXISTS 'PENDING_MELT';
ALTER TYPE "inventory"."MovementType" ADD VALUE IF NOT EXISTS 'BUYBACK';
CREATE TYPE "inventory"."ItemOrigin" AS ENUM ('STANDARD', 'BOUGHT_BACK');
CREATE TYPE "inventory"."ReceiptSource" AS ENUM ('STANDARD', 'BUYBACK');
