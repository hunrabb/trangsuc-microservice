import { z } from 'zod';

const money = z.string().regex(/^(0|[1-9]\d{0,17})\.\d{2}$/);
const weight = z.string().regex(/^(0|[1-9]\d{0,7})\.\d{4}$/);
const purity = z.string().regex(/^(0|[1-9]\d{0,3})\.\d{4}$/);

export const buybackSettledLineSchema = z.strictObject({
  quoteLineId: z.uuid(),
  intakeItemId: z.uuid(),
  metalId: z.uuid(),
  metalKind: z.enum(['GOLD', 'SILVER']),
  acceptedWeight: weight,
  purityPerMille: purity,
  amount: money,
});

export const buybackSettledEventSchema = z.strictObject({
  version: z.literal(1),
  settlementId: z.uuid(),
  intakeId: z.uuid(),
  quoteId: z.uuid(),
  branchId: z.uuid(),
  kind: z.enum(['DIRECT', 'EXCHANGE']),
  approvedAmount: money,
  saleAmount: money.nullable(),
  direction: z.enum(['STORE_PAYS', 'CUSTOMER_PAYS', 'NONE']),
  amountDue: money,
  settledAt: z.iso.datetime(),
  confirmedBy: z.uuid(),
  createdBy: z.uuid(),
  lines: z.array(buybackSettledLineSchema).min(1).max(20),
});

export const buybackStockedEventSchema = z.strictObject({
  version: z.literal(1),
  settlementId: z.uuid(),
  branchId: z.uuid(),
  warehouseId: z.uuid(),
  receiptId: z.uuid(),
  receivedAt: z.iso.datetime(),
  approvedAmount: money,
  items: z
    .array(
      buybackSettledLineSchema.extend({
        jewelryItemId: z.uuid(),
        tagCode: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
});

export type BuybackSettledEvent = z.infer<typeof buybackSettledEventSchema>;
export type BuybackStockedEvent = z.infer<typeof buybackStockedEventSchema>;
