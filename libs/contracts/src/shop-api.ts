import { z } from 'zod';
import { moneySchema } from './inventory-api';

export const shopQuerySchema = z
  .strictObject({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    search: z.string().trim().max(100).optional(),
    categoryId: z.uuid().optional(),
    metalKind: z.enum(['GOLD', 'SILVER']).optional(),
    minPrice: moneySchema.optional(),
    maxPrice: moneySchema.optional(),
    sort: z.enum(['name', 'price_asc', 'price_desc']).default('name'),
  })
  .refine(
    (q) =>
      q.minPrice === undefined ||
      q.maxPrice === undefined ||
      Number(q.minPrice) <= Number(q.maxPrice),
    { message: 'minPrice phải <= maxPrice' },
  );
export type ShopQuery = z.infer<typeof shopQuerySchema>;
export const publicVariantSchema = z.strictObject({
  id: z.uuid(),
  sku: z.string().max(200),
  name: z.string().max(500),
  metalKind: z.enum(['GOLD', 'SILVER']),
  estimatedPrice: z
    .string()
    .regex(/^\d{1,18}\.\d{2}$/)
    .nullable(),
});
export const productSnapshotSchema = z.strictObject({
  id: z.uuid(),
  categoryId: z.uuid(),
  categoryName: z.string().max(500),
  name: z.string().max(500),
  description: z.string().max(10000).nullable(),
  imageUrl: z.string().max(2048).nullable(),
  isActive: z.boolean(),
  version: z.number().int().positive(),
  capturedAt: z.iso.datetime(),
  variants: z.array(publicVariantSchema).max(200),
});
export const availabilitySnapshotSchema = z.strictObject({
  variantId: z.uuid(),
  available: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  capturedAt: z.iso.datetime(),
});
export const shopProductSchema = productSnapshotSchema
  .omit({ version: true, isActive: true })
  .extend({
    variants: z.array(publicVariantSchema.extend({ inStock: z.boolean() })).max(200),
    inStock: z.boolean(),
  });
export const shopPageSchema = z.object({
  items: z.array(shopProductSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int(),
  pageSize: z.number().int(),
});

export const onlineWarehouseSchema = z.strictObject({ acceptsOnlineOrders: z.boolean() });
export const onlineBufferSchema = z.strictObject({
  quantity: z.number().int().min(0).max(1000000),
});
export type OnlineWarehouse = z.infer<typeof onlineWarehouseSchema>;
export type OnlineBuffer = z.infer<typeof onlineBufferSchema>;
