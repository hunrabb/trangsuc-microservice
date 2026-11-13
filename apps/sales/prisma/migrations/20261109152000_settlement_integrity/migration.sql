ALTER TABLE "sales"."BuybackSettlement" ADD COLUMN "confirmationNote" text;

ALTER TABLE "sales"."BuybackSettlement"
  ADD CONSTRAINT buyback_settlement_evidence CHECK (
    (status IN ('RESERVING','AWAITING_PAYMENT','CANCELLING','CANCELLED')
      AND "paymentReference" IS NULL AND "paymentEvidence" IS NULL AND "paymentRecordedBy" IS NULL
      AND "paymentConfirmedAt" IS NULL AND "verificationReference" IS NULL AND "confirmationNote" IS NULL)
    OR (status = 'PAYMENT_RECORDED'
      AND "paymentReference" IS NOT NULL AND "paymentEvidence" IS NOT NULL AND "paymentRecordedBy" IS NOT NULL
      AND "paymentConfirmedAt" IS NULL AND "verificationReference" IS NULL AND "confirmationNote" IS NULL)
    OR (status IN ('FULFILLING','RECONCILIATION_REQUIRED','SETTLED')
      AND "paymentReference" IS NOT NULL AND "paymentEvidence" IS NOT NULL AND "paymentRecordedBy" IS NOT NULL
      AND "paymentConfirmedAt" IS NOT NULL AND "verificationReference" IS NOT NULL
      AND "paymentConfirmedBy" <> "createdBy" AND "paymentConfirmedBy" <> "paymentRecordedBy")
  ),
  ADD CONSTRAINT buyback_settlement_order CHECK (
    (kind = 'DIRECT' AND "orderId" IS NULL AND status NOT IN ('RESERVING','FULFILLING','RECONCILIATION_REQUIRED'))
    OR (kind = 'EXCHANGE' AND
        ((status = 'SETTLED' AND "orderId" = id) OR (status <> 'SETTLED' AND "orderId" IS NULL)))
  ),
  ADD CONSTRAINT buyback_settlement_reservation CHECK (
    kind = 'DIRECT' AND "reservationId" IS NULL AND "saleSnapshot" IS NULL
    OR kind = 'EXCHANGE' AND
       ((status IN ('RESERVING','CANCELLING','CANCELLED') AND "saleAmount" IS NULL)
        OR ("saleAmount" IS NOT NULL AND "reservationId" = id AND "reservationExpiresAt" IS NOT NULL
            AND "saleSnapshot" IS NOT NULL))
  ),
  ADD CONSTRAINT buyback_settlement_order_fk FOREIGN KEY ("orderId") REFERENCES "sales"."Order"(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION "sales".buyback_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NOT (
      OLD.status = NEW.status AND OLD.status IN ('RESERVING','CANCELLING','FULFILLING','RECONCILIATION_REQUIRED')
      OR OLD.status = 'RESERVING' AND NEW.status IN ('AWAITING_PAYMENT','CANCELLING','CANCELLED')
      OR OLD.status = 'AWAITING_PAYMENT' AND NEW.status IN ('PAYMENT_RECORDED','CANCELLING','CANCELLED')
      OR OLD.status = 'PAYMENT_RECORDED' AND NEW.status IN ('FULFILLING','SETTLED')
      OR OLD.status = 'FULFILLING' AND NEW.status IN ('RECONCILIATION_REQUIRED','SETTLED')
      OR OLD.status = 'RECONCILIATION_REQUIRED' AND NEW.status = 'SETTLED'
      OR OLD.status = 'CANCELLING' AND NEW.status = 'CANCELLED'
    ) THEN RAISE EXCEPTION 'Invalid settlement state transition'; END IF;
    IF (OLD."intakeId",OLD."quoteId",OLD."branchId",OLD.kind,OLD.method,OLD."approvedAmount",OLD."tagCode",OLD."createdBy",OLD."creationKey",OLD."creationHash",OLD."createdAt") IS DISTINCT FROM
       (NEW."intakeId",NEW."quoteId",NEW."branchId",NEW.kind,NEW.method,NEW."approvedAmount",NEW."tagCode",NEW."createdBy",NEW."creationKey",NEW."creationHash",NEW."createdAt") THEN
      RAISE EXCEPTION 'Settlement source snapshot is immutable';
    END IF;
    IF OLD."saleAmount" IS NOT NULL AND
       (OLD."saleAmount",OLD.difference,OLD.direction,OLD."amountDue",OLD."reservationId",OLD."reservationExpiresAt",OLD."saleSnapshot") IS DISTINCT FROM
       (NEW."saleAmount",NEW.difference,NEW.direction,NEW."amountDue",NEW."reservationId",NEW."reservationExpiresAt",NEW."saleSnapshot") THEN
      RAISE EXCEPTION 'Exchange price and reservation snapshot are immutable';
    END IF;
    IF OLD."paymentReference" IS NOT NULL AND
       (OLD."paymentReference",OLD."paymentEvidence",OLD."paymentRecordedBy") IS DISTINCT FROM
       (NEW."paymentReference",NEW."paymentEvidence",NEW."paymentRecordedBy") THEN
      RAISE EXCEPTION 'Payment evidence is immutable';
    END IF;
    IF OLD."paymentConfirmedAt" IS NOT NULL AND
       (OLD."paymentConfirmedAt",OLD."paymentConfirmedBy",OLD."verificationReference",OLD."confirmationNote") IS DISTINCT FROM
       (NEW."paymentConfirmedAt",NEW."paymentConfirmedBy",NEW."verificationReference",NEW."confirmationNote") THEN
      RAISE EXCEPTION 'Payment confirmation is immutable';
    END IF;
    IF OLD."orderId" IS NOT NULL AND OLD."orderId" IS DISTINCT FROM NEW."orderId" THEN
      RAISE EXCEPTION 'Exchange order identity is immutable';
    END IF;
    IF NEW.version <> OLD.version+1 THEN RAISE EXCEPTION 'Settlement version must advance once'; END IF;
  END IF;
  RETURN NEW;
END $$;
