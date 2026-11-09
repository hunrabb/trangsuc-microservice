import { z } from 'zod';

/**
 * API NỘI BỘ của inventory cho sales (luồng POS). Đường `/internal/stock/*`: gateway không bao giờ chuyển tiếp,
 * chỉ gọi được trong mạng Docker. Tiền (đồng) và trọng lượng (chỉ) là chuỗi số thập phân.
 */

/** Số chiếc tối đa mỗi lần gọi: một hoá đơn POS không bao giờ lớn hơn thế này. */
export const MAX_TAGS_PER_REQUEST = 100;

const tagCodes = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(MAX_TAGS_PER_REQUEST)
  .refine((tags) => new Set(tags).size === tags.length, { error: 'Mã tem bị lặp trong yêu cầu' });

// ---------------------------------------------------------------- quote
export const quoteStockRequestSchema = z.strictObject({
  tagCodes,
  branchId: z
    .uuid()
    .optional()
    .describe('Có thì chỉ chiếc thuộc kho chi nhánh này mới "còn bán được"'),
});

export const unavailableReasonSchema = z.enum(['NOT_FOUND', 'WRONG_BRANCH', 'NOT_IN_STOCK']);

export const quoteItemSchema = z.object({
  tagCode: z.string(),
  available: z.boolean(),
  reason: unavailableReasonSchema.nullable(),
  weight: z.string().nullable(),
  laborFee: z.string().nullable(),
  metalSellPricePerChi: z.string().nullable().describe('null nếu kim loại chưa có giá'),
  price: z.string().nullable().describe('null nếu kim loại chưa có giá'),
});

export const quoteStockResponseSchema = z.object({ items: z.array(quoteItemSchema) });

// ---------------------------------------------------------------- deduct
export const deductStockRequestSchema = z.strictObject({
  orderId: z.uuid(),
  branchId: z.uuid(),
  tagCodes,
});

/** Đủ để sales chép lại vào dòng hoá đơn lúc bán (giá được chốt tại đây, không tính lại về sau). */
export const deductedItemSchema = z.object({
  itemId: z.uuid(),
  tagCode: z.string(),
  productName: z.string().min(1).optional().describe('Tên mẫu để sales chép vào hoá đơn POS'),
  weight: z.string(),
  laborFee: z.string(),
  metalSellPricePerChi: z.string(),
  price: z.string(),
  /** Giá vốn chiếc tại lúc deduct; sales chỉ chép snapshot này, không đọc database kho. */
  costPrice: z.string(),
  variantId: z.uuid(),
  metalId: z.uuid(),
});

export const deductStockResponseSchema = z.object({
  orderId: z.uuid(),
  branchId: z.uuid(),
  replayed: z.boolean().describe('true nếu đây là lần gọi lặp, trả lại kết quả cũ'),
  items: z.array(deductedItemSchema),
});

// ---------------------------------------------------------------- release
export const releaseStockRequestSchema = z.strictObject({ orderId: z.uuid() });

export const releaseStockResponseSchema = z.object({
  orderId: z.uuid(),
  releasedTagCodes: z
    .array(z.string())
    .describe('Rỗng nếu đơn không còn chiếc nào đang giữ (gọi lặp)'),
});

// Trạng thái bền vững dùng để Sales phục hồi sau khi mất phản hồi HTTP.
export const stockOrderStateResponseSchema = z.object({
  orderId: z.uuid(),
  released: z.boolean(),
  soldItems: z.array(z.object({ tagCode: z.string(), branchId: z.uuid() })),
});

export type QuoteStockRequest = z.infer<typeof quoteStockRequestSchema>;
export type QuoteItem = z.infer<typeof quoteItemSchema>;
export type QuoteStockResponse = z.infer<typeof quoteStockResponseSchema>;
export type DeductStockRequest = z.infer<typeof deductStockRequestSchema>;
export type DeductedItem = z.infer<typeof deductedItemSchema>;
export type DeductStockResponse = z.infer<typeof deductStockResponseSchema>;
export type ReleaseStockRequest = z.infer<typeof releaseStockRequestSchema>;
export type ReleaseStockResponse = z.infer<typeof releaseStockResponseSchema>;
export type StockOrderStateResponse = z.infer<typeof stockOrderStateResponseSchema>;
