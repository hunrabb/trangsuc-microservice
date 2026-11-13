import { z } from 'zod';
import { pageOf, paginationQuerySchema } from './auth-api';

/**
 * Schema body/response của inventory API, dùng chung cho inventory và backoffice.
 * Đặc tả: docs/api/inventory.openapi.yaml. Chạy được cả trên trình duyệt.
 * Tiền và trọng lượng là CHUỖI số thập phân, không phải number, để không mất độ chính xác.
 */

const nonEmpty = z.string().min(1);
const version = z.number().int().positive();

const decimalString = (maxIntDigits: number, maxFractionDigits: number) =>
  z.string().regex(new RegExp(`^\\d{1,${maxIntDigits}}(\\.\\d{1,${maxFractionDigits}})?$`), {
    error: `Phải là số không âm, tối đa ${maxFractionDigits} chữ số thập phân`,
  });

const isZero = (value: string) => /^0+(\.0+)?$/.test(value);

/** Tiền, đồng. `Decimal(15,2)`. */
export const moneySchema = decimalString(13, 2).describe('Số tiền (đồng), chuỗi thập phân');
export const positiveMoneySchema = moneySchema.refine((value) => !isZero(value), {
  error: 'Phải lớn hơn 0',
});
/** Trọng lượng, đơn vị chỉ. `Decimal(12,4)`. */
export const positiveWeightSchema = decimalString(8, 4)
  .refine((value) => !isZero(value), { error: 'Phải lớn hơn 0' })
  .describe('Trọng lượng (chỉ), chuỗi thập phân');

// ---------------------------------------------------------------- Kim loại và giá
export const metalKindSchema = z.enum(['GOLD', 'SILVER']);

export const metalSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  kind: metalKindSchema,
  isActive: z.boolean(),
  version,
});

export const createMetalRequestSchema = z.strictObject({
  code: nonEmpty,
  name: nonEmpty,
  kind: metalKindSchema,
});

export const metalPriceSchema = z.object({
  id: z.uuid(),
  metalId: z.uuid(),
  buyPrice: z.string(),
  sellPrice: z.string(),
  effectiveFrom: z.iso.datetime(),
  createdBy: z.uuid(),
});

/** Bỏ trống `effectiveFrom` = có hiệu lực ngay. Giá bán ra không được thấp hơn giá mua vào. */
export const createMetalPriceRequestSchema = z
  .strictObject({
    buyPrice: positiveMoneySchema,
    sellPrice: positiveMoneySchema,
    effectiveFrom: z.iso.datetime().optional(),
  })
  .refine((body) => Number(body.sellPrice) >= Number(body.buyPrice), {
    path: ['sellPrice'],
    error: 'Giá bán ra không được thấp hơn giá mua vào',
  });

export const metalPricePageSchema = pageOf(metalPriceSchema);

// ---------------------------------------------------------------- Danh mục, mẫu, biến thể
export const categorySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  isActive: z.boolean(),
  version,
});
export const createCategoryRequestSchema = z.strictObject({ name: nonEmpty });
export const updateCategoryRequestSchema = z.strictObject({
  version,
  name: nonEmpty.optional(),
  isActive: z.boolean().optional(),
});

export const productSchema = z.object({
  publishedOnline: z.boolean(),
  imageUrl: z.string().nullable(),
  id: z.uuid(),
  categoryId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  version,
});
export const createProductRequestSchema = z.strictObject({
  categoryId: z.uuid(),
  name: nonEmpty,
  description: z.string().optional(),
});
export const updateProductRequestSchema = z.strictObject({
  publishedOnline: z.boolean().optional(),
  imageUrl: z
    .union([
      z
        .url()
        .max(2048)
        .refine((url) => url.startsWith('https://')),
      z.string().regex(/^\/catalog-images\/[a-f0-9]{64}\.(?:jpg|jpeg|png|webp)$/),
    ])
    .nullable()
    .optional(),
  version,
  categoryId: z.uuid().optional(),
  name: nonEmpty.optional(),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});
export const listProductsQuerySchema = paginationQuerySchema.extend({
  categoryId: z.uuid().optional(),
});
export const productPageSchema = pageOf(productSchema);

export const variantSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  metalId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  defaultLaborFee: z.string(),
  isActive: z.boolean(),
  version,
});
export const createVariantRequestSchema = z.strictObject({
  productId: z.uuid(),
  metalId: z.uuid(),
  sku: nonEmpty,
  name: nonEmpty,
  defaultLaborFee: moneySchema.optional(),
});
export const updateVariantRequestSchema = z.strictObject({
  version,
  name: nonEmpty.optional(),
  defaultLaborFee: moneySchema.optional(),
  isActive: z.boolean().optional(),
});
export const listVariantsQuerySchema = paginationQuerySchema.extend({
  productId: z.uuid().optional(),
});
export const variantPageSchema = pageOf(variantSchema);

// ---------------------------------------------------------------- Phiếu nhập
export const receiptStatusSchema = z.enum(['DRAFT', 'APPROVED']);

export const receiptLineSchema = z.object({
  id: z.uuid(),
  variantId: z.uuid(),
  tagCode: z.string(),
  weight: z.string(),
  laborFee: z.string(),
  costPrice: z.string(),
});

export const receiptSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  branchId: z.uuid(),
  status: receiptStatusSchema,
  note: z.string().nullable(),
  createdBy: z.uuid(),
  approvedBy: z.uuid().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  version,
  lines: z.array(receiptLineSchema),
});

export const createReceiptRequestSchema = z.strictObject({
  branchId: z.uuid(),
  note: z.string().optional(),
});

/** Bỏ trống `laborFee` = lấy tiền công mặc định của biến thể. */
export const addReceiptLineRequestSchema = z.strictObject({
  variantId: z.uuid(),
  tagCode: nonEmpty.max(64),
  weight: positiveWeightSchema,
  laborFee: moneySchema.optional(),
  costPrice: positiveMoneySchema,
});

export const approveReceiptRequestSchema = z.strictObject({ version });

export const listReceiptsQuerySchema = paginationQuerySchema.extend({
  branchId: z.uuid().optional(),
  status: receiptStatusSchema.optional(),
});
export const receiptPageSchema = pageOf(receiptSchema);

// ---------------------------------------------------------------- Tồn kho
export const itemStatusSchema = z.enum(['IN_STOCK', 'RESERVED', 'SOLD', 'PENDING_MELT']);

export const itemSchema = z.object({
  id: z.uuid(),
  tagCode: z.string(),
  branchId: z.uuid(),
  variantId: z.uuid(),
  sku: z.string(),
  productName: z.string(),
  variantName: z.string(),
  metalName: z.string(),
  weight: z.string(),
  laborFee: z.string(),
  costPrice: z
    .string()
    .nullable()
    .describe('Chỉ ADMIN và MANAGER thấy giá vốn; người khác nhận null'),
  status: itemStatusSchema,
  version,
});

export const listItemsQuerySchema = paginationQuerySchema.extend({
  branchId: z.uuid().optional(),
  variantId: z.uuid().optional(),
  status: itemStatusSchema.optional(),
});
export const itemPageSchema = pageOf(itemSchema);

/** Món hàng kèm giá hiện tại: `price` = trọng lượng × giá bán ra + tiền công, làm tròn tới 1.000 đồng. */
export const itemWithPriceSchema = itemSchema.extend({
  sellPricePerChi: z.string(),
  price: z.string(),
});

export type CreateMetalRequest = z.infer<typeof createMetalRequestSchema>;
export type CreateMetalPriceRequest = z.infer<typeof createMetalPriceRequestSchema>;
export type Metal = z.infer<typeof metalSchema>;
export type MetalPrice = z.infer<typeof metalPriceSchema>;
export type MetalPricePage = z.infer<typeof metalPricePageSchema>;
export type Category = z.infer<typeof categorySchema>;
export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;
export type Product = z.infer<typeof productSchema>;
export type CreateProductRequest = z.infer<typeof createProductRequestSchema>;
export type UpdateProductRequest = z.infer<typeof updateProductRequestSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
export type ProductPage = z.infer<typeof productPageSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type CreateVariantRequest = z.infer<typeof createVariantRequestSchema>;
export type UpdateVariantRequest = z.infer<typeof updateVariantRequestSchema>;
export type ListVariantsQuery = z.infer<typeof listVariantsQuerySchema>;
export type VariantPage = z.infer<typeof variantPageSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type ReceiptPage = z.infer<typeof receiptPageSchema>;
export type CreateReceiptRequest = z.infer<typeof createReceiptRequestSchema>;
export type AddReceiptLineRequest = z.infer<typeof addReceiptLineRequestSchema>;
export type ApproveReceiptRequest = z.infer<typeof approveReceiptRequestSchema>;
export type ListReceiptsQuery = z.infer<typeof listReceiptsQuerySchema>;
export type Item = z.infer<typeof itemSchema>;
export type ItemPage = z.infer<typeof itemPageSchema>;
export type ItemWithPrice = z.infer<typeof itemWithPriceSchema>;
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>;

// ---------------------------------------------------------------- Dữ liệu tem
/** Dữ liệu để frontend dựng tem. Giá tạm tính = `null` nếu kim loại chưa có giá. */
export const itemLabelSchema = z.object({
  tagCode: z.string(),
  productName: z.string(),
  variantName: z.string(),
  sku: z.string(),
  metalName: z.string().describe('Gồm tuổi kim loại, ví dụ "Vàng 18K"'),
  metalKind: metalKindSchema,
  weight: z.string(),
  sellPricePerChi: z.string().nullable(),
  estimatedPrice: z.string().nullable(),
});

export type ItemLabel = z.infer<typeof itemLabelSchema>;

/** Tổng hợp mỗi biến thể trong một chi nhánh, tính từ từng JewelryItem. */
export const stockSummaryQuerySchema = paginationQuerySchema.extend({
  branchId: z.uuid(),
  variantId: z.uuid().optional(),
});
export const stockSummarySchema = z.object({
  branchId: z.uuid(),
  branchName: z.string(),
  variantId: z.uuid(),
  productName: z.string(),
  variantName: z.string(),
  sku: z.string(),
  metalName: z.string(),
  total: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  sold: z.number().int().nonnegative(),
  pendingMelt: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
});
export const stockSummaryPageSchema = pageOf(stockSummarySchema);
export type StockSummaryQuery = z.infer<typeof stockSummaryQuerySchema>;
export type StockSummaryPage = z.infer<typeof stockSummaryPageSchema>;
