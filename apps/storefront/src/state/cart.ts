import { onlineCartSchema, shopProductSchema } from '@jewelry/contracts';
import type { ShopProduct } from '../api/shop.ts';
import { cents } from './catalog.ts';

export type CartItem = { productId: string; variantId: string; quantity: number };
export const CART_KEY = 'jewelry.storefront.cart.v1';
export const CART_TTL_MS = 7 * 24 * 60 * 60_000;
export type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function validateCart(items: CartItem[]): CartItem[] {
  if (items.length === 0) return [];
  onlineCartSchema.parse(items.map(({ variantId, quantity }) => ({ variantId, quantity })));
  for (const item of items) shopProductSchema.shape.id.parse(item.productId);
  return items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity }));
}
export function setCartQuantity(items: CartItem[], item: CartItem, quantity: number): CartItem[] {
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error('Số lượng không hợp lệ.');
  const next = items.flatMap((i) =>
    i.variantId === item.variantId ? (quantity > 0 ? [{ ...i, quantity }] : []) : [i],
  );
  if (quantity > 0 && !items.some((i) => i.variantId === item.variantId))
    next.push({ ...item, quantity });
  return validateCart(next);
}
export function addCartItem(
  items: CartItem[],
  product: ShopProduct,
  variantId: string,
  quantity: number,
): CartItem[] {
  if (!Number.isInteger(quantity) || quantity < 1)
    throw new Error('Vui lòng chọn ít nhất một sản phẩm.');
  const variant = product.variants.find((v) => v.id === variantId);
  if (!variant?.inStock || variant.estimatedPrice === null)
    throw new Error('Món này hiện chưa thể thêm vào giỏ.');
  return setCartQuantity(
    items,
    { productId: product.id, variantId, quantity },
    (items.find((i) => i.variantId === variantId)?.quantity ?? 0) + quantity,
  );
}
export function readCart(storage?: StoragePort, now = Date.now()): CartItem[] {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(CART_KEY) ?? 'null');
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('version' in raw) ||
      raw.version !== 1 ||
      !('expiresAt' in raw) ||
      typeof raw.expiresAt !== 'number' ||
      raw.expiresAt <= now ||
      raw.expiresAt > now + CART_TTL_MS ||
      !('items' in raw) ||
      !Array.isArray(raw.items)
    )
      return [];
    return validateCart(raw.items);
  } catch {
    return [];
  }
}
export function persistCart(storage: StoragePort | undefined, items: CartItem[]): boolean {
  try {
    if (!storage) return false;
    storage.setItem(
      CART_KEY,
      JSON.stringify({
        version: 1,
        expiresAt: Date.now() + CART_TTL_MS,
        items: validateCart(items),
      }),
    );
    return true;
  } catch {
    return false;
  }
}
export function inspectCart(items: CartItem[], products: Map<string, ShopProduct>) {
  const lines = items.map((item) => {
    const product = products.get(item.productId);
    const variant = product?.variants.find((v) => v.id === item.variantId);
    const available = !!variant?.inStock && variant.estimatedPrice !== null;
    return {
      item,
      product,
      variant,
      available,
      subtotal:
        variant?.estimatedPrice !== undefined && variant.estimatedPrice !== null
          ? cents(variant.estimatedPrice) * BigInt(item.quantity)
          : null,
    };
  });
  const ready = items.length > 0 && lines.every((line) => line.available);
  const total = lines.every((line) => line.subtotal !== null)
    ? lines.reduce((sum, line) => sum + line.subtotal!, 0n)
    : null;
  return { lines, ready, total };
}
