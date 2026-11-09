import {
  createOnlineOrderSchema,
  checkoutAuthorizationSchema,
  onlineOrderViewSchema,
  onlineCartSchema,
  shopProductSchema,
  idempotencyKeySchema,
  type CreateOnlineOrder,
} from '@jewelry/contracts';
import type { ShopApi, ShopOrder } from '../api/shop.ts';
import { ShopApiError } from '../api/shop.ts';
import type { StoragePort } from './cart.ts';

export const CHECKOUT_KEY = 'jewelry.storefront.checkout.v1';
export const ACCESS_TTL_MS = 72 * 60 * 60_000;
export const CHECKOUT_BODY_TTL_MS = 30 * 60_000;
export type CheckoutAttempt = {
  id: string;
  token: string;
  key: string;
  body: CreateOnlineOrder | null;
  cart: { variantId: string; quantity: number }[];
  orderId: string | null;
  sent: boolean;
  createdAt: number;
  expiresAt: number;
  lastStatus: ShopOrder['status'] | null;
};
export class CheckoutStorageError extends Error {
  constructor() {
    super(
      'Chưa thể lưu quyền tra cứu đơn trong tab này. Vui lòng cho phép lưu dữ liệu phiên rồi tải lại trang để thử lại.',
    );
  }
}
export class UncertainCheckoutError extends Error {
  constructor() {
    super(
      'Chưa xác định được kết quả đặt hàng. Yêu cầu và mã tra cứu đã được giữ lại; hãy kiểm tra trước khi đặt tiếp.',
    );
  }
}
export class CheckoutVault {
  private attempts: CheckoutAttempt[];
  private activeId: string | null = null;
  constructor(
    private readonly storage?: StoragePort,
    now = Date.now(),
  ) {
    this.attempts = [];
    try {
      const saved = JSON.parse(storage?.getItem(CHECKOUT_KEY) ?? 'null');
      if (saved?.version === 1 && Array.isArray(saved.attempts)) {
        this.attempts = saved.attempts.slice(-5).flatMap((value: CheckoutAttempt) => {
          try {
            if (
              !value ||
              !Number.isFinite(value.createdAt) ||
              value.expiresAt <= now ||
              value.createdAt > now ||
              value.expiresAt > value.createdAt + ACCESS_TTL_MS ||
              !Number.isFinite(value.expiresAt)
            )
              return [];
            checkoutAuthorizationSchema.parse(`Checkout ${value.token}`);
            idempotencyKeySchema.parse(value.key);
            shopProductSchema.shape.id.parse(value.id);
            if (value.orderId !== null) shopProductSchema.shape.id.parse(value.orderId);
            if (value.body !== null) createOnlineOrderSchema.parse(value.body);
            if (value.lastStatus !== null)
              onlineOrderViewSchema.shape.status.parse(value.lastStatus);
            const cart = value.cart.length ? onlineCartSchema.parse(value.cart) : [];
            return [
              {
                id: value.id,
                token: value.token,
                key: value.key,
                body:
                  value.orderId === null && now < value.createdAt + CHECKOUT_BODY_TTL_MS
                    ? value.body
                    : null,
                cart,
                orderId: value.orderId,
                sent: value.sent === true,
                createdAt: value.createdAt,
                expiresAt: value.expiresAt,
                lastStatus: value.lastStatus,
              },
            ];
          } catch {
            return [];
          }
        });
        this.activeId = this.attempts.some((a) => a.id === saved.activeId) ? saved.activeId : null;
      }
    } catch {
      this.attempts = [];
      this.activeId = null;
    }
    // Loại credential quá hạn khỏi storage ngay khi mở phiên, không gia hạn thời gian giữ.
    try {
      this.persist();
    } catch {
      /* Checkout mới vẫn bắt buộc lưu được trước khi POST. */
    }
  }
  list(now = Date.now()): CheckoutAttempt[] {
    const live = this.attempts
      .filter((a) => a.expiresAt > now)
      .map((a) => (a.body && now >= a.createdAt + CHECKOUT_BODY_TTL_MS ? { ...a, body: null } : a));
    if (live.length !== this.attempts.length || live.some((a, i) => a !== this.attempts[i])) {
      this.attempts = live;
      try {
        this.persist();
      } catch {
        /* Hạn truy cập vẫn được thực thi trong bộ nhớ. */
      }
    }
    return live;
  }
  active(): CheckoutAttempt | undefined {
    const live = this.list();
    return live.find((a) => a.orderId === null) ?? live.find((a) => a.id === this.activeId);
  }
  forOrder(id: string): CheckoutAttempt | undefined {
    // A customer may correct a mistyped token for the same order after a 403.
    return this.list().findLast((a) => a.orderId === id);
  }
  private persist(): void {
    if (!this.storage) throw new CheckoutStorageError();
    try {
      this.storage.setItem(
        CHECKOUT_KEY,
        JSON.stringify({ version: 1, activeId: this.activeId, attempts: this.attempts }),
      );
    } catch {
      throw new CheckoutStorageError();
    }
  }
  save(attempt: CheckoutAttempt): void {
    const others = this.list().filter((a) => a.id !== attempt.id);
    if (others.length >= 5) {
      const index = others.findIndex((a) => a.orderId !== null);
      if (index < 0) throw new UncertainCheckoutError();
      others.splice(index, 1);
    }
    this.attempts = [...others, attempt];
    this.activeId = attempt.id;
    this.persist();
  }
  prepare(body: CreateOnlineOrder, cryptoPort: Crypto = globalThis.crypto): CheckoutAttempt {
    const checked = createOnlineOrderSchema.parse(body);
    if (this.active()) throw new UncertainCheckoutError();
    const now = Date.now();
    const attempt: CheckoutAttempt = {
      id: cryptoPort.randomUUID(),
      key: cryptoPort.randomUUID(),
      token: Array.from(cryptoPort.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
      body: checked,
      cart: checked.items,
      orderId: null,
      sent: false,
      createdAt: now,
      expiresAt: now + ACCESS_TTL_MS,
      lastStatus: null,
    };
    this.save(attempt); // Nếu không lưu được, coordinator tuyệt đối không gửi POST.
    return attempt;
  }
  known(attempt: CheckoutAttempt, order: ShopOrder): void {
    this.save({ ...attempt, orderId: order.id, lastStatus: order.status, body: null }); // Xoá PII ngay khi có ID đơn.
  }
  startNew(): void {
    if (this.list().some((a) => a.orderId === null)) throw new UncertainCheckoutError();
    this.activeId = null;
    this.persist();
  }
  forget(id: string): void {
    if (this.list().some((a) => a.id === id && a.orderId === null))
      throw new UncertainCheckoutError();
    this.attempts = this.list().filter((a) => a.id !== id);
    if (this.activeId === id) this.activeId = null;
    this.persist();
  }
  importAccess(orderId: string, token: string): CheckoutAttempt {
    shopProductSchema.shape.id.parse(orderId);
    const checked = token.trim().replace(/^Checkout /, '');
    checkoutAuthorizationSchema.parse(`Checkout ${checked}`);
    const now = Date.now();
    const attempt: CheckoutAttempt = {
      id: globalThis.crypto.randomUUID(),
      token: checked,
      key: globalThis.crypto.randomUUID(),
      body: null,
      cart: [],
      orderId,
      sent: true,
      createdAt: now,
      expiresAt: now + ACCESS_TTL_MS,
      lastStatus: null,
    };
    this.save(attempt);
    return attempt;
  }
}
/** Latch đồng bộ ngăn double click trước khi React render; không có automatic retry POST. */
export class CheckoutCoordinator {
  private flight: Promise<ShopOrder> | undefined;
  constructor(
    private readonly api: ShopApi,
    private readonly vault: CheckoutVault,
  ) {}
  get busy(): boolean {
    return this.flight !== undefined;
  }
  private exclusive(work: () => Promise<ShopOrder>): Promise<ShopOrder> {
    if (this.flight) return this.flight;
    this.flight = Promise.resolve()
      .then(work)
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }
  submit(body: CreateOnlineOrder): Promise<ShopOrder> {
    return this.exclusive(async () => {
      const active = this.vault.active();
      if (active) throw new UncertainCheckoutError();
      const attempt = this.vault.prepare(body);
      return this.post(attempt);
    });
  }
  retrySame(): Promise<ShopOrder> {
    return this.exclusive(async () => {
      const attempt = this.vault.active();
      if (!attempt?.body || attempt.orderId) throw new UncertainCheckoutError();
      return this.post(attempt);
    });
  }
  recover(): Promise<ShopOrder> {
    return this.exclusive(async () => {
      const attempt = this.vault.active();
      if (!attempt) throw new UncertainCheckoutError();
      const order = await this.api.byKey(attempt.token, attempt.key);
      this.vault.known(attempt, order);
      return order;
    });
  }
  private async post(attempt: CheckoutAttempt): Promise<ShopOrder> {
    if (!attempt.body || attempt.expiresAt <= Date.now()) throw new UncertainCheckoutError();
    this.vault.save({ ...attempt, sent: true });
    try {
      const order = await this.api.create(attempt.body, attempt.token, attempt.key);
      this.vault.known(attempt, order);
      return order;
    } catch (error) {
      if (error instanceof ShopApiError && error.status === 422) throw error;
      throw new UncertainCheckoutError();
    }
  }
}
export const orderPresentation: Record<
  ShopOrder['status'],
  { title: string; description: string; tone: string; step: number }
> = {
  PENDING: {
    title: 'Đang kiểm tra sản phẩm',
    description:
      'Yêu cầu đã được tiếp nhận. Cửa hàng đang kiểm tra sản phẩm để giữ cho đơn của bạn.',
    tone: 'neutral',
    step: 0,
  },
  AWAITING_PAYMENT: {
    title: 'Đang chờ thanh toán',
    description:
      'Sản phẩm đã được giữ tạm thời. Vui lòng chỉ chuyển khoản theo hướng dẫn được cửa hàng xác nhận.',
    tone: 'gold',
    step: 1,
  },
  PAYMENT_PROCESSING: {
    title: 'Đã ghi nhận khoản thanh toán',
    description:
      'Cửa hàng đang xác nhận tình trạng sản phẩm sau khi xác minh khoản thanh toán của bạn.',
    tone: 'gold',
    step: 2,
  },
  CONFIRMED: {
    title: 'Đơn hàng đã được xác nhận',
    description:
      'Khoản thanh toán và sản phẩm đã được xác nhận cho đơn của bạn. Chưa có thông tin giao hàng.',
    tone: 'success',
    step: 3,
  },
  PAYMENT_REVIEW: {
    title: 'Khoản thanh toán cần được kiểm tra',
    description:
      'Vui lòng giữ lại chứng từ giao dịch. Cửa hàng cần đối soát khoản thanh toán và tình trạng sản phẩm.',
    tone: 'warning',
    step: 2,
  },
  REFUND_PENDING: {
    title: 'Đã ghi nhận yêu cầu hoàn tiền',
    description: 'Yêu cầu đang chờ xử lý. Chưa có xác nhận khoản tiền đã được hoàn.',
    tone: 'warning',
    step: 2,
  },
  CANCELLED: {
    title: 'Yêu cầu đặt hàng đã kết thúc',
    description:
      'Đơn đã bị huỷ hoặc không còn đủ điều kiện tiếp tục. Bạn có thể kiểm tra giỏ để chọn lại sản phẩm.',
    tone: 'neutral',
    step: 0,
  },
};
export function orderPollInterval(order?: ShopOrder): number | false {
  if (!order) return false;
  if (order.status === 'PENDING') return 3000;
  if (['AWAITING_PAYMENT', 'PAYMENT_PROCESSING'].includes(order.status)) return 5000;
  if (order.status === 'PAYMENT_REVIEW') return 15000;
  return false;
}
