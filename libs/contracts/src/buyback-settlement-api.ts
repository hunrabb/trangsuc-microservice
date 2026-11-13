import { z } from 'zod';

const version = z.number().int().positive();
const money = z.string().regex(/^(0|[1-9]\d{0,17})\.\d{2}$/);
export const settlementMethodSchema = z.enum(['CASH', 'BANK_TRANSFER']);
export const settlementStatusSchema = z.enum([
  'RESERVING',
  'AWAITING_PAYMENT',
  'PAYMENT_RECORDED',
  'FULFILLING',
  'SETTLED',
  'RECONCILIATION_REQUIRED',
  'CANCELLING',
  'CANCELLED',
]);
export const createSettlementSchema = z.strictObject({ version, method: settlementMethodSchema });
export const createExchangeSchema = createSettlementSchema.extend({
  tagCode: z.string().trim().min(1).max(64),
});
export const recordSettlementPaymentSchema = z.strictObject({
  version,
  reference: z.string().trim().min(5).max(120),
  evidence: z.string().trim().min(10).max(1000),
});
export const confirmSettlementPaymentSchema = z.strictObject({
  version,
  verificationReference: z.string().trim().min(5).max(120),
  note: z.string().trim().min(10).max(1000),
});
export const cancelSettlementSchema = z.strictObject({
  version,
  reason: z.string().trim().min(10).max(500),
});
export const settlementViewSchema = z.strictObject({
  id: z.uuid(),
  intakeId: z.uuid(),
  quoteId: z.uuid(),
  branchId: z.uuid(),
  kind: z.enum(['DIRECT', 'EXCHANGE']),
  status: settlementStatusSchema,
  version,
  method: settlementMethodSchema,
  approvedAmount: money,
  saleAmount: money.nullable(),
  difference: z
    .string()
    .regex(/^-?\d+\.\d{2}$/)
    .nullable(),
  direction: z.enum(['STORE_PAYS', 'CUSTOMER_PAYS', 'NONE']).nullable(),
  amountDue: money.nullable(),
  tagCode: z.string().nullable(),
  reservationId: z.uuid().nullable(),
  reservationExpiresAt: z.iso.datetime().nullable(),
  paymentReference: z.string().nullable(),
  paymentEvidence: z.string().nullable(),
  paymentRecordedBy: z.uuid().nullable(),
  paymentConfirmedBy: z.uuid().nullable(),
  paymentConfirmedAt: z.iso.datetime().nullable(),
  confirmationNote: z.string().nullable(),
  orderId: z.uuid().nullable(),
  failureCode: z.string().nullable(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CreateSettlement = z.infer<typeof createSettlementSchema>;
export type CreateExchange = z.infer<typeof createExchangeSchema>;
export type RecordSettlementPayment = z.infer<typeof recordSettlementPaymentSchema>;
export type ConfirmSettlementPayment = z.infer<typeof confirmSettlementPaymentSchema>;
export type CancelSettlement = z.infer<typeof cancelSettlementSchema>;
export type SettlementView = z.infer<typeof settlementViewSchema>;
