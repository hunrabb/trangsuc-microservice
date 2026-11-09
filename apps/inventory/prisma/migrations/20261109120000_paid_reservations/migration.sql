ALTER TYPE "inventory"."ReservationStatus" ADD VALUE 'PAID_HELD';
ALTER TABLE "inventory"."StockReservation" ADD COLUMN "paymentVersion" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "paymentId" UUID,
 ADD COLUMN "paymentReceivedAt" TIMESTAMPTZ(3), ADD COLUMN "paymentOutcome" TEXT, ADD COLUMN "paymentFailureCode" TEXT;

ALTER TABLE "inventory"."StockReservation" ADD CONSTRAINT "StockReservation_paid_fields"
 CHECK ("status"::text <> 'PAID_HELD' OR ("paymentId" IS NOT NULL AND "paymentReceivedAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND "paymentOutcome" = 'CONFIRMED'));
