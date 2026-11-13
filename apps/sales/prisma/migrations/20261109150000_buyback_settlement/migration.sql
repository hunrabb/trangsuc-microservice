CREATE TYPE "sales"."BuybackSettlementKind" AS ENUM ('DIRECT', 'EXCHANGE');
CREATE TYPE "sales"."BuybackSettlementStatus" AS ENUM ('RESERVING', 'AWAITING_PAYMENT', 'PAYMENT_RECORDED', 'FULFILLING', 'SETTLED', 'RECONCILIATION_REQUIRED', 'CANCELLING', 'CANCELLED');
CREATE TYPE "sales"."BuybackPaymentDirection" AS ENUM ('STORE_PAYS', 'CUSTOMER_PAYS', 'NONE');
CREATE TYPE "sales"."BuybackPaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER');

CREATE TABLE "sales"."BuybackSettlement" (
  id uuid PRIMARY KEY,
  "intakeId" uuid NOT NULL REFERENCES "sales"."BuybackIntake"(id) ON DELETE RESTRICT,
  "quoteId" uuid NOT NULL REFERENCES "sales"."BuybackQuote"(id) ON DELETE RESTRICT,
  "branchId" uuid NOT NULL,
  kind "sales"."BuybackSettlementKind" NOT NULL,
  status "sales"."BuybackSettlementStatus" NOT NULL,
  version integer NOT NULL DEFAULT 1,
  method "sales"."BuybackPaymentMethod" NOT NULL,
  "approvedAmount" numeric(20,2) NOT NULL,
  "saleAmount" numeric(20,2),
  difference numeric(20,2),
  direction "sales"."BuybackPaymentDirection",
  "amountDue" numeric(20,2),
  "tagCode" text,
  "reservationId" uuid,
  "reservationExpiresAt" timestamptz(3),
  "saleSnapshot" jsonb,
  "paymentReference" text UNIQUE,
  "paymentEvidence" text,
  "paymentRecordedBy" uuid,
  "paymentConfirmedBy" uuid,
  "paymentConfirmedAt" timestamptz(3),
  "verificationReference" text,
  "orderId" uuid UNIQUE,
  "failureCode" text,
  "recoveryAttempts" integer NOT NULL DEFAULT 0,
  "createdBy" uuid NOT NULL,
  "creationKey" text NOT NULL,
  "creationHash" text NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT buyback_settlement_values CHECK (
    version > 0 AND "approvedAmount" >= 0 AND
    (kind = 'DIRECT' AND "saleAmount" IS NULL AND difference IS NULL AND "tagCode" IS NULL
      AND direction = 'STORE_PAYS' AND "amountDue" = "approvedAmount"
     OR kind = 'EXCHANGE' AND "tagCode" IS NOT NULL AND
      ((status IN ('RESERVING','CANCELLING','CANCELLED') AND "saleAmount" IS NULL AND direction IS NULL AND "amountDue" IS NULL)
       OR ("saleAmount" >= 0 AND difference = "saleAmount" - "approvedAmount" AND
           ((difference > 0 AND direction = 'CUSTOMER_PAYS' AND "amountDue" = difference)
            OR (difference < 0 AND direction = 'STORE_PAYS' AND "amountDue" = -difference)
            OR (difference = 0 AND direction = 'NONE' AND "amountDue" = 0)))))
  ),
  CONSTRAINT buyback_settlement_paid CHECK (
    ("paymentConfirmedAt" IS NULL AND "paymentConfirmedBy" IS NULL)
    OR ("paymentConfirmedAt" IS NOT NULL AND "paymentConfirmedBy" IS NOT NULL AND status IN ('FULFILLING','SETTLED','RECONCILIATION_REQUIRED'))
  )
);
CREATE UNIQUE INDEX "BuybackSettlement_one_live_intake" ON "sales"."BuybackSettlement"("intakeId") WHERE status <> 'CANCELLED';
CREATE INDEX "BuybackSettlement_status_updatedAt_idx" ON "sales"."BuybackSettlement"(status,"updatedAt");
CREATE INDEX "BuybackSettlement_branchId_createdAt_idx" ON "sales"."BuybackSettlement"("branchId","createdAt");
CREATE INDEX "BuybackSettlement_intakeId_createdAt_idx" ON "sales"."BuybackSettlement"("intakeId","createdAt");
CREATE UNIQUE INDEX "BuybackSettlement_intakeId_createdBy_creationKey_key" ON "sales"."BuybackSettlement"("intakeId","createdBy","creationKey");

CREATE TABLE "sales"."BuybackSettlementAudit" (
  id uuid PRIMARY KEY,
  "settlementId" uuid NOT NULL REFERENCES "sales"."BuybackSettlement"(id) ON DELETE RESTRICT,
  "actorId" uuid,
  action text NOT NULL,
  "fromStatus" "sales"."BuybackSettlementStatus",
  "toStatus" "sales"."BuybackSettlementStatus" NOT NULL,
  "fromVersion" integer,
  "toVersion" integer NOT NULL,
  detail jsonb NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE("settlementId","toVersion")
);
CREATE TABLE "sales"."BuybackSettlementRequest" (
  id uuid PRIMARY KEY,
  "settlementId" uuid NOT NULL REFERENCES "sales"."BuybackSettlement"(id) ON DELETE RESTRICT,
  "actorId" uuid NOT NULL,
  "idempotencyKey" text NOT NULL,
  "requestHash" text NOT NULL,
  result jsonb NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE("settlementId","actorId","idempotencyKey")
);
CREATE TABLE "sales"."TradeInItem" (
  id uuid PRIMARY KEY,
  "orderId" uuid NOT NULL REFERENCES "sales"."Order"(id) ON DELETE RESTRICT,
  "quoteLineId" uuid NOT NULL UNIQUE REFERENCES "sales"."BuybackQuoteLine"(id) ON DELETE RESTRICT,
  "intakeItemId" uuid NOT NULL,
  "metalId" uuid NOT NULL,
  "acceptedWeight" numeric(12,4) NOT NULL CHECK ("acceptedWeight">0),
  amount numeric(20,2) NOT NULL CHECK (amount>=0)
);
CREATE INDEX "TradeInItem_orderId_idx" ON "sales"."TradeInItem"("orderId");

CREATE FUNCTION "sales".buyback_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i record; q record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "branchId", status, "activeQuoteId" INTO i FROM "sales"."BuybackIntake" WHERE id=NEW."intakeId" FOR SHARE;
    SELECT "intakeId", status, total INTO q FROM "sales"."BuybackQuote" WHERE id=NEW."quoteId" FOR SHARE;
    IF i IS NULL OR q IS NULL OR i.status <> 'APPROVED' OR i."branchId" <> NEW."branchId" OR i."activeQuoteId" <> NEW."quoteId"
       OR q."intakeId" <> NEW."intakeId" OR q.status <> 'APPROVED' OR q.total <> NEW."approvedAmount" THEN
      RAISE EXCEPTION 'Settlement requires its own approved immutable quote';
    END IF;
  ELSE
    IF OLD.status IN ('SETTLED','CANCELLED') THEN RAISE EXCEPTION 'Terminal settlement is immutable'; END IF;
    IF (OLD."intakeId",OLD."quoteId",OLD."branchId",OLD.kind,OLD.method,OLD."approvedAmount",OLD."tagCode",OLD."createdBy",OLD."creationKey",OLD."creationHash",OLD."createdAt") IS DISTINCT FROM
       (NEW."intakeId",NEW."quoteId",NEW."branchId",NEW.kind,NEW.method,NEW."approvedAmount",NEW."tagCode",NEW."createdBy",NEW."creationKey",NEW."creationHash",NEW."createdAt") THEN
      RAISE EXCEPTION 'Settlement source snapshot is immutable';
    END IF;
    IF OLD."paymentReference" IS NOT NULL AND OLD."paymentReference" IS DISTINCT FROM NEW."paymentReference" THEN
      RAISE EXCEPTION 'Payment reference is immutable';
    END IF;
    IF OLD."saleAmount" IS NOT NULL AND
       (OLD."saleAmount",OLD.difference,OLD.direction,OLD."amountDue",OLD."reservationId",OLD."reservationExpiresAt",OLD."saleSnapshot") IS DISTINCT FROM
       (NEW."saleAmount",NEW.difference,NEW.direction,NEW."amountDue",NEW."reservationId",NEW."reservationExpiresAt",NEW."saleSnapshot") THEN
      RAISE EXCEPTION 'Exchange price and reservation snapshot are immutable';
    END IF;
    IF OLD."paymentConfirmedAt" IS NOT NULL AND (OLD."paymentConfirmedAt",OLD."paymentConfirmedBy") IS DISTINCT FROM (NEW."paymentConfirmedAt",NEW."paymentConfirmedBy") THEN
      RAISE EXCEPTION 'Payment confirmation is immutable';
    END IF;
    IF NEW.version <> OLD.version+1 THEN RAISE EXCEPTION 'Settlement version must advance once'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER buyback_settlement_guard BEFORE INSERT OR UPDATE ON "sales"."BuybackSettlement"
FOR EACH ROW EXECUTE FUNCTION "sales".buyback_settlement_guard();

CREATE FUNCTION "sales".buyback_settlement_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Settlement audit and request history are append-only'; END $$;
CREATE TRIGGER buyback_settlement_audit_immutable BEFORE UPDATE OR DELETE ON "sales"."BuybackSettlementAudit"
FOR EACH ROW EXECUTE FUNCTION "sales".buyback_settlement_append_only();
CREATE TRIGGER buyback_settlement_request_immutable BEFORE UPDATE OR DELETE ON "sales"."BuybackSettlementRequest"
FOR EACH ROW EXECUTE FUNCTION "sales".buyback_settlement_append_only();
