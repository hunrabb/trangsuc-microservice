import { z } from 'zod';

const uuid = z.uuid();
export const reserveExchangeSchema = z.strictObject({
  exchangeId: uuid,
  branchId: uuid,
  tagCode: z.string().min(1).max(64),
});
export const exchangeHoldSchema = z.strictObject({
  exchangeId: uuid,
  branchId: uuid,
  status: z.enum(['ACTIVE', 'PROTECTED', 'CONSUMED', 'EXPIRED', 'RELEASED']),
  tagCode: z.string(),
  itemId: uuid,
  variantId: uuid,
  metalId: uuid,
  productName: z.string(),
  weight: z.string(),
  laborFee: z.string(),
  metalSellPricePerChi: z.string(),
  price: z.string(),
  costPrice: z.string(),
  expiresAt: z.iso.datetime().nullable(),
});
export const exchangeReleaseSchema = z.strictObject({ exchangeId: uuid });
export type ReserveExchange = z.infer<typeof reserveExchangeSchema>;
export type ExchangeHold = z.infer<typeof exchangeHoldSchema>;
