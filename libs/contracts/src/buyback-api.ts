import { z } from 'zod';
import { positiveWeightSchema } from './inventory-api';
import { pageOf } from './auth-api';
import { customerPhoneSchema } from './sales-api';

/** Task 7.1–7.2: tiếp nhận, kiểm định và duyệt giá; chưa chi tiền/nhập kho. */
export const buybackStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPRAISAL',
  'CANCELLED',
  'APPRAISED',
  'APPROVED',
  'REJECTED',
]);
export const buybackAssetKindSchema = z.enum(['GOLD', 'SILVER', 'JEWELRY']);
const queryInteger = (maximum: number) =>
  z
    .union([z.string().regex(/^\d+$/), z.number()])
    .pipe(z.coerce.number<string | number>().int().min(1).max(maximum));
const note = (length: number) => z.string().trim().min(1).max(length).nullable().default(null);
export const buybackCustomerInputSchema = z.union([
  z.strictObject({ customerId: z.uuid() }),
  z.strictObject({ name: z.string().trim().min(1).max(150), phone: customerPhoneSchema }),
]);
export const buybackItemInputSchema = z
  .strictObject({
    source: z.enum(['STORE_TAG', 'EXTERNAL']),
    referenceTagCode: note(100).describe(
      'Bắt buộc với STORE_TAG, phải null với EXTERNAL; chỉ là tham chiếu chưa xác minh',
    ),
    assetKind: buybackAssetKindSchema,
    description: z.string().trim().min(1).max(1000),
    condition: z.string().trim().min(1).max(1000),
    declaredWeight: positiveWeightSchema
      .nullable()
      .default(null)
      .describe('Trọng lượng khách khai, đơn vị chỉ; chưa kiểm định'),
    initialMeasuredWeight: positiveWeightSchema
      .nullable()
      .default(null)
      .describe('Số đo ban đầu, đơn vị chỉ; chưa xác nhận kiểm định'),
    declaredPurity: note(100).describe('Hàm lượng khách khai, không phải kết quả kiểm định'),
    notes: note(1000),
  })
  .refine(
    (item) =>
      item.source === 'STORE_TAG' ? item.referenceTagCode !== null : item.referenceTagCode === null,
    {
      message:
        'STORE_TAG cần mã tem tham chiếu; EXTERNAL không được nhận tem cửa hàng chưa kiểm chứng',
    },
  );
export const createBuybackSchema = z.strictObject({
  customer: buybackCustomerInputSchema,
  notes: note(2000),
  items: z
    .array(buybackItemInputSchema)
    .min(1)
    .max(20)
    .refine((items) => {
      const tags = items.flatMap((item) =>
        item.referenceTagCode === null ? [] : [item.referenceTagCode],
      );
      return new Set(tags).size === tags.length;
    }, 'Không lặp mã tem trong cùng phiếu'),
});
export const updateBuybackSchema = createBuybackSchema.extend({
  version: z.number().int().positive(),
});
export const submitBuybackSchema = z.strictObject({ version: z.number().int().positive() });
export const cancelBuybackSchema = submitBuybackSchema.extend({
  reason: z.string().trim().min(5).max(500),
});
export const buybackQuerySchema = z
  .strictObject({
    page: queryInteger(10000).default(1),
    pageSize: queryInteger(50).default(20),
    status: buybackStatusSchema.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .refine(
    (query) => !query.from || !query.to || Date.parse(query.from) <= Date.parse(query.to),
    'from phải không sau to (UTC, lọc theo thời điểm tiếp nhận)',
  );
export const buybackSummarySchema = z.strictObject({
  id: z.uuid(),
  code: z.string().max(50),
  branchId: z.uuid(),
  createdBy: z.uuid(),
  customerId: z.uuid().nullable(),
  customerName: z.string().max(150),
  status: buybackStatusSchema,
  version: z.number().int().positive(),
  receivedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  itemCount: z.number().int().min(1).max(20),
});
export const buybackItemSchema = buybackItemInputSchema.safeExtend({
  id: z.uuid(),
  position: z.number().int().min(1).max(20),
});
export const buybackAuditSchema = z.strictObject({
  id: z.uuid(),
  actorId: z.uuid(),
  branchId: z.uuid(),
  action: z.enum([
    'CREATED',
    'UPDATED',
    'SUBMITTED',
    'CANCELLED',
    'APPRAISED',
    'QUOTED',
    'APPROVED',
    'REJECTED',
  ]),
  fromStatus: buybackStatusSchema.nullable(),
  toStatus: buybackStatusSchema,
  fromVersion: z.number().int().positive().nullable(),
  toVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});
export const buybackDetailSchema = buybackSummarySchema.extend({
  customerPhone: z.string().regex(/^0\d{9,10}$/),
  notes: z.string().max(2000).nullable(),
  cancellationReason: z.string().max(500).nullable(),
  items: z.array(buybackItemSchema).min(1).max(20),
  latestAudit: z.array(buybackAuditSchema).max(50),
});
export const buybackPageSchema = pageOf(buybackSummarySchema);
export type CreateBuyback = z.infer<typeof createBuybackSchema>;
export type UpdateBuyback = z.infer<typeof updateBuybackSchema>;
export type SubmitBuyback = z.infer<typeof submitBuybackSchema>;
export type CancelBuyback = z.infer<typeof cancelBuybackSchema>;
export type BuybackQuery = z.infer<typeof buybackQuerySchema>;
export type BuybackDetail = z.infer<typeof buybackDetailSchema>;
