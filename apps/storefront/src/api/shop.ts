import { accountToken } from './account.ts';
import {
  shopPageSchema,
  shopProductSchema,
  onlineOrderViewSchema,
  shopQuerySchema,
  createOnlineOrderSchema,
  checkoutAuthorizationSchema,
  idempotencyKeySchema,
  type ShopQuery,
  type CreateOnlineOrder,
} from '@jewelry/contracts';

export type ShopProduct = ReturnType<typeof shopProductSchema.parse>;
export type ShopPage = ReturnType<typeof shopPageSchema.parse>;
export type ShopOrder = ReturnType<typeof onlineOrderViewSchema.parse>;
const messages: Record<string, string> = {
  ITEM_NOT_AVAILABLE: 'Một số món không còn khả dụng. Bạn có thể quay lại giỏ để chọn lại.',
  PRICE_NOT_AVAILABLE: 'Giá sản phẩm đang được cập nhật. Vui lòng kiểm tra lại sau.',
  IDEMPOTENCY_KEY_REUSED:
    'Yêu cầu đặt hàng này đã được tiếp nhận với thông tin khác. Hãy kiểm tra đơn trước khi thao tác tiếp.',
  INVALID_STATE: 'Trạng thái đơn đã thay đổi. Vui lòng cập nhật đơn để tiếp tục.',
  RATE_LIMITED: 'Bạn thao tác hơi nhanh. Vui lòng chờ một phút rồi thử lại.',
  SERVICE_UNAVAILABLE: 'Cửa hàng đang tạm gián đoạn kết nối. Vui lòng thử lại sau.',
  RESERVATION_EXPIRED: 'Yêu cầu đã hết thời gian giữ sản phẩm.',
};
export class ShopApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(
      status === 404
        ? 'Không tìm thấy thông tin hoặc bạn chưa có quyền truy cập.'
        : (messages[code] ?? 'Chưa thể kết nối để xác nhận thông tin. Vui lòng thử lại.'),
    );
  }
}
export const failureText = (code: string | null) =>
  code ? (messages[code] ?? 'Yêu cầu này cần được cửa hàng kiểm tra thêm.') : null;
export function canRetryRead(count: number, error: unknown): boolean {
  return count < 1 && error instanceof ShopApiError && (error.status === 0 || error.status >= 500);
}
/** Cùng origin Gateway; không dùng cookie/backoffice token và không ghi request/secret vào log. */
export function createShopApi(
  fetcher: typeof fetch = (...args) => fetch(...args),
  getAccountToken = accountToken,
) {
  async function send<T>(
    path: string,
    schema: { parse(value: unknown): T },
    options: {
      method?: 'GET' | 'POST';
      body?: unknown;
      token?: string;
      key?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 12_000);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.token)
        headers.Authorization = checkoutAuthorizationSchema.parse(`Checkout ${options.token}`);
      if (options.key) headers['Idempotency-Key'] = idempotencyKeySchema.parse(options.key);
      let target = path;
      if (path === '/orders' && options.method === 'POST') {
        const bearer = await getAccountToken();
        if (bearer) {
          target = '/my-orders';
          headers['X-Checkout-Authorization'] = headers.Authorization!;
          headers.Authorization = `Bearer ${bearer}`;
        }
      }
      const response = await fetcher(`/api/shop${target}`, {
        method: options.method ?? 'GET',
        credentials: 'omit',
        cache: 'no-store',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        let code = 'UNAVAILABLE';
        try {
          const data: unknown = await response.json();
          if (data && typeof data === 'object' && 'code' in data && typeof data.code === 'string')
            code = data.code;
        } catch {
          /* Không đưa nội dung lỗi nội bộ ra giao diện. */
        }
        throw new ShopApiError(response.status, code);
      }
      return schema.parse(await response.json());
    } catch (error) {
      if (error instanceof ShopApiError) throw error;
      throw new ShopApiError(0, 'UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
  return {
    list(query: ShopQuery, signal?: AbortSignal) {
      const checked = shopQuerySchema.parse(query);
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(checked))
        if (value !== undefined && value !== '') params.set(key, String(value));
      return send(`/products?${params}`, shopPageSchema, { signal });
    },
    product(id: string, signal?: AbortSignal) {
      const checked = shopProductSchema.shape.id.parse(id);
      return send(`/products/${checked}`, shopProductSchema, { signal });
    },
    create(body: CreateOnlineOrder, token: string, key: string) {
      return send('/orders', onlineOrderViewSchema, {
        method: 'POST',
        body: createOnlineOrderSchema.parse(body),
        token,
        key,
      });
    },
    byKey(token: string, key: string, signal?: AbortSignal) {
      return send('/orders/by-key', onlineOrderViewSchema, { token, key, signal });
    },
    order(id: string, token: string, signal?: AbortSignal) {
      return send(`/orders/${shopProductSchema.shape.id.parse(id)}`, onlineOrderViewSchema, {
        token,
        signal,
      });
    },
    cancel(id: string, token: string) {
      return send(`/orders/${shopProductSchema.shape.id.parse(id)}/cancel`, onlineOrderViewSchema, {
        method: 'POST',
        token,
      });
    },
  };
}
export type ShopApi = ReturnType<typeof createShopApi>;
export const shopApi = createShopApi();
