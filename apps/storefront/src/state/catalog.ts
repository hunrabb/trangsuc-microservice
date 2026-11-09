import { shopQuerySchema, type ShopQuery } from '@jewelry/contracts';
import type { ShopProduct } from '../api/shop.ts';

export function catalogQuery(params: URLSearchParams) {
  const allowed = ['search', 'categoryId', 'metalKind', 'minPrice', 'maxPrice', 'sort', 'page'];
  return shopQuerySchema.safeParse({
    pageSize: 12,
    ...Object.fromEntries(
      allowed.flatMap((key) =>
        params.has(key) && params.get(key) !== '' ? [[key, params.get(key)]] : [],
      ),
    ),
  });
}
export function catalogParams(query: Partial<ShopQuery>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (
      key !== 'pageSize' &&
      value !== undefined &&
      value !== '' &&
      !(key === 'page' && value === 1) &&
      !(key === 'sort' && value === 'name')
    )
      params.set(key, String(value));
  return params;
}
export function cents(price: string): bigint {
  if (!/^\d{1,18}\.\d{2}$/.test(price)) throw new Error('Giá không hợp lệ');
  return BigInt(price.replace('.', ''));
}
export function money(value: bigint | string | null): string {
  if (value === null) return 'Đang cập nhật giá';
  const amount = typeof value === 'string' ? cents(value) : value;
  const fraction = amount % 100n;
  return `${new Intl.NumberFormat('vi-VN').format(amount / 100n)}${fraction === 0n ? '' : `,${fraction.toString().padStart(2, '0')}`}\u00a0₫`;
}
export type VariantFilters = Pick<ShopQuery, 'metalKind' | 'minPrice' | 'maxPrice'>;
/** API list sorts by matching variants but returns the complete product DTO. */
export function matchingVariants(product: ShopProduct, filters: VariantFilters = {}) {
  const bound = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  };
  const min = filters.minPrice === undefined ? null : bound(filters.minPrice);
  const max = filters.maxPrice === undefined ? null : bound(filters.maxPrice);
  return product.variants.filter((variant) => {
    if (filters.metalKind && variant.metalKind !== filters.metalKind) return false;
    if (min === null && max === null) return true;
    if (variant.estimatedPrice === null) return false;
    const price = cents(variant.estimatedPrice);
    return (min === null || price >= min) && (max === null || price <= max);
  });
}
export function productPrice(product: ShopProduct, filters: VariantFilters = {}): bigint | null {
  const values = matchingVariants(product, filters).flatMap((v) =>
    v.estimatedPrice !== null ? [cents(v.estimatedPrice)] : [],
  );
  return values.length ? values.reduce((a, b) => (a < b ? a : b)) : null;
}
export const metalName = (kind: string) => (kind === 'GOLD' ? 'Vàng' : 'Bạc');
export function safeImageUrl(input: string | null): string | undefined {
  if (!input) return undefined;
  if (input.startsWith('/') && !input.startsWith('//') && !input.includes('\\')) return input;
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
