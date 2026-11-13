-- SQL CHECK treats UNKNOWN as success. Explicit non-null predicates close that gap
-- for nullable payment, reservation and order columns.
ALTER TABLE "sales"."BuybackSettlement"
ADD CONSTRAINT buyback_settlement_strict_state CHECK (
  (kind = 'DIRECT' AND "saleAmount" IS NULL AND difference IS NULL AND "tagCode" IS NULL
    AND direction = 'STORE_PAYS' AND "amountDue" = "approvedAmount"
    AND "reservationId" IS NULL AND "saleSnapshot" IS NULL AND "orderId" IS NULL)
  OR
  (kind = 'EXCHANGE' AND "tagCode" IS NOT NULL AND
    ((status IN ('RESERVING','CANCELLING','CANCELLED') AND "saleAmount" IS NULL AND difference IS NULL
      AND direction IS NULL AND "amountDue" IS NULL AND "reservationId" IS NULL AND "saleSnapshot" IS NULL)
    OR (status <> 'RESERVING' AND "saleAmount" IS NOT NULL AND difference IS NOT NULL
      AND direction IS NOT NULL AND "amountDue" IS NOT NULL
      AND "reservationId" IS NOT NULL AND "reservationId" = id
      AND "reservationExpiresAt" IS NOT NULL AND "saleSnapshot" IS NOT NULL
      AND difference = "saleAmount" - "approvedAmount"
      AND ((difference > 0 AND direction = 'CUSTOMER_PAYS' AND "amountDue" = difference)
        OR (difference < 0 AND direction = 'STORE_PAYS' AND "amountDue" = -difference)
        OR (difference = 0 AND direction = 'NONE' AND "amountDue" = 0))
      AND ((status = 'SETTLED' AND "orderId" IS NOT NULL AND "orderId" = id)
        OR (status <> 'SETTLED' AND "orderId" IS NULL)))))
),
ADD CONSTRAINT buyback_settlement_strict_payment CHECK (
  (status IN ('RESERVING','AWAITING_PAYMENT','CANCELLING','CANCELLED')
    AND "paymentReference" IS NULL AND "paymentEvidence" IS NULL AND "paymentRecordedBy" IS NULL
    AND "paymentConfirmedBy" IS NULL AND "paymentConfirmedAt" IS NULL AND "verificationReference" IS NULL)
  OR (status = 'PAYMENT_RECORDED' AND "paymentReference" IS NOT NULL
    AND "paymentEvidence" IS NOT NULL AND "paymentRecordedBy" IS NOT NULL
    AND "paymentConfirmedBy" IS NULL AND "paymentConfirmedAt" IS NULL AND "verificationReference" IS NULL)
  OR (status IN ('FULFILLING','RECONCILIATION_REQUIRED','SETTLED')
    AND "paymentReference" IS NOT NULL AND "paymentEvidence" IS NOT NULL AND "paymentRecordedBy" IS NOT NULL
    AND "paymentConfirmedBy" IS NOT NULL AND "paymentConfirmedAt" IS NOT NULL
    AND "verificationReference" IS NOT NULL
    AND "paymentConfirmedBy" <> "createdBy" AND "paymentConfirmedBy" <> "paymentRecordedBy")
);
