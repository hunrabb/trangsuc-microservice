import { z } from 'zod';
import { moneySchema, positiveMoneySchema, positiveWeightSchema } from './inventory-api';
import { buybackStatusSchema } from './buyback-api';

const version = z.number().int().positive().max(2147483647);
const note = z.string().trim().min(1).max(1000).nullable().default(null);
const reason = z.string().trim().min(5).max(500);
const scaled = (s: string) =>
  typeof s === 'string' && /^\d{1,8}(\.\d{1,4})?$/.test(s)
    ? BigInt(s.split('.')[0]! + (s.split('.')[1] ?? '').padEnd(4, '0'))
    : -1n;
/** Hàm lượng phần nghìn, không phải karat/phần trăm. Giá Inventory đã theo tuổi kim loại. */
export const buybackPuritySchema = z
  .string()
  .regex(/^\d{1,4}(\.\d{1,4})?$/)
  .refine(
    (s) => scaled(s) > 0n && scaled(s) <= 10000000n,
    'Hàm lượng phải >0 và <=1000 phần nghìn',
  );
const metalKind = z.enum(['GOLD', 'SILVER']);
export const appraisalInputSchema = z
  .strictObject({
    version,
    measuredWeight: positiveWeightSchema,
    acceptedWeight: positiveWeightSchema,
    metalId: z.uuid(),
    metalKind,
    purityPerMille: buybackPuritySchema,
    condition: z.string().trim().min(1).max(1000),
    notes: note,
  })
  .refine(
    (b) => scaled(b.acceptedWeight) <= scaled(b.measuredWeight),
    'Trọng lượng chấp nhận không vượt số đo thực',
  );
export const buybackAppraisalSchema = z
  .strictObject({ ...appraisalInputSchema.shape })
  .omit({ version: true })
  .extend({
    id: z.uuid(),
    itemId: z.uuid(),
    intakeId: z.uuid(),
    intakeVersion: version,
    appraisedBy: z.uuid(),
    appraisedAt: z.iso.datetime(),
  });
export const buybackAppraisalsSchema = z.strictObject({
  intakeId: z.uuid(),
  status: buybackStatusSchema,
  version,
  items: z.array(buybackAppraisalSchema).max(20),
});
export const createBuybackPolicySchema = z.strictObject({
  metalId: z.uuid(),
  metalKind,
  purityPerMille: buybackPuritySchema,
  label: z.string().trim().min(1).max(150),
  deductionVndPerItem: moneySchema,
  reason,
});
export const updateBuybackPolicySchema = createBuybackPolicySchema
  .pick({ label: true, deductionVndPerItem: true, reason: true })
  .extend({ version, isActive: z.boolean() });
export const buybackPolicySchema = createBuybackPolicySchema.omit({ reason: true }).extend({
  id: z.uuid(),
  branchId: z.uuid(),
  version,
  isActive: z.boolean(),
  createdBy: z.uuid(),
  updatedAt: z.iso.datetime(),
});
export const buybackQuoteInputSchema = z
  .strictObject({
    version,
    items: z
      .array(z.strictObject({ itemId: z.uuid(), policyId: z.uuid(), policyVersion: version }))
      .min(1)
      .max(20),
  })
  .refine(
    (b) => new Set(b.items.map((i) => i.itemId)).size === b.items.length,
    'Không lặp món báo giá',
  );
export const buybackDecisionSchema = z.strictObject({ version });
export const rejectBuybackQuoteSchema = buybackDecisionSchema.extend({ reason });
export const inventoryBuybackPriceSchema = z.strictObject({
  metalId: z.uuid(),
  metalCode: z.string().min(1),
  metalKind,
  priceId: z.uuid(),
  buyPricePerChi: positiveMoneySchema,
  unit: z.literal('VND_PER_CHI_ALLOY'),
  effectiveFrom: z.iso.datetime(),
  capturedAt: z.iso.datetime(),
});
const total = z.string().regex(/^\d{1,18}\.\d{2}$/);
export const buybackQuoteLineSchema = z.strictObject({
  itemId: z.uuid(),
  appraisalId: z.uuid(),
  appraisedBy: z.uuid(),
  measuredWeight: positiveWeightSchema,
  acceptedWeight: positiveWeightSchema,
  metalId: z.uuid(),
  metalKind,
  purityPerMille: buybackPuritySchema,
  policyId: z.uuid(),
  policyVersion: version,
  priceId: z.uuid(),
  metalCode: z.string(),
  unit: z.literal('VND_PER_CHI_ALLOY'),
  unitPrice: positiveMoneySchema,
  effectiveFrom: z.iso.datetime(),
  capturedAt: z.iso.datetime(),
  deductionVndPerItem: moneySchema,
  amount: total,
});
export const buybackQuoteSchema = z.strictObject({
  id: z.uuid(),
  intakeId: z.uuid(),
  sourceVersion: version,
  status: z.enum(['QUOTED', 'SUPERSEDED', 'APPROVED', 'REJECTED']),
  currency: z.literal('VND'),
  total,
  rounding: z.literal('HALF_UP_1000_VND_PER_LINE'),
  requireSeparateApprover: z.literal(true),
  quotedBy: z.uuid(),
  quotedAt: z.iso.datetime(),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  rejectionReason: z.string().nullable(),
  lines: z.array(buybackQuoteLineSchema).min(1).max(20),
});
export const buybackQuotesSchema = z.strictObject({
  intakeId: z.uuid(),
  status: buybackStatusSchema,
  version,
  activeQuoteId: z.uuid().nullable(),
  quotes: z.array(buybackQuoteSchema).max(50),
});
export type AppraisalInput = z.infer<typeof appraisalInputSchema>;
export type CreateBuybackPolicy = z.infer<typeof createBuybackPolicySchema>;
export type UpdateBuybackPolicy = z.infer<typeof updateBuybackPolicySchema>;
export type BuybackQuoteInput = z.infer<typeof buybackQuoteInputSchema>;
export type InventoryBuybackPrice = z.infer<typeof inventoryBuybackPriceSchema>;
export type BuybackQuote = z.infer<typeof buybackQuoteSchema>;
