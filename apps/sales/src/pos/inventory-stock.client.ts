import { BusinessError, callInternal, ConfigService } from '@jewelry/common';
import {
  type DeductStockResponse,
  type StockOrderStateResponse,
  deductStockResponseSchema,
  quoteStockResponseSchema,
  releaseStockResponseSchema,
  stockOrderStateResponseSchema,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Env } from '../config/env';
import type { OrderRecord } from '../core/order-record';

/** API kho chỉ dành POS; HTTP luôn ngoài transaction sales, timeout 3 giây/lượt, retry lỗi tạm thời tối đa hai lần. */
@Injectable()
export class InventoryStockClient {
  constructor(private readonly config: ConfigService<Env, true>) {}

  /** Quote không khoá hàng; hết hàng báo mã tem, chưa có giá báo riêng và không tự tính giá tại sales. */
  async quote(order: OrderRecord): Promise<void> {
    const response = quoteStockResponseSchema.parse(
      await this.post('quote', {
        branchId: order.branchId,
        tagCodes: order.requestedTagCodes,
      }),
    );
    this.assertTagSet(
      response.items.map((item) => item.tagCode),
      order,
    );
    const unavailable = response.items
      .filter((item) => !item.available)
      .map((item) => item.tagCode);
    if (unavailable.length > 0) {
      throw new BusinessError('ITEM_NOT_AVAILABLE', 'Có món hàng không còn bán được', 409, {
        tagCodes: unavailable,
      });
    }
    if (response.items.some((item) => item.price === null || item.metalSellPricePerChi === null)) {
      throw new BusinessError('METAL_PRICE_NOT_SET', 'Kim loại chưa có giá', 409);
    }
  }

  /** Deduct idempotent theo orderId; xác nhận đủ snapshot và đúng bộ mã tem trước khi ghi hoá đơn. */
  async deduct(order: OrderRecord): Promise<DeductStockResponse> {
    const response = deductStockResponseSchema.parse(
      await this.post('deduct', {
        orderId: order.id,
        branchId: order.branchId,
        tagCodes: order.requestedTagCodes,
      }),
    );
    this.assertTagSet(
      response.items.map((item) => item.tagCode),
      order,
    );
    if (
      response.orderId !== order.id ||
      response.branchId !== order.branchId ||
      response.items.some((item) => item.productName === undefined)
    ) {
      throw new BusinessError(
        'SERVICE_UNAVAILABLE',
        'Inventory trả snapshot hoá đơn chưa đầy đủ',
        503,
      );
    }
    return response;
  }

  /** Release có thể gọi lại sau timeout; chỉ trả thành công khi kho xác nhận đúng orderId. */
  async release(orderId: string): Promise<void> {
    const response = releaseStockResponseSchema.parse(await this.post('release', { orderId }));
    if (response.orderId !== orderId)
      throw new BusinessError('SERVICE_UNAVAILABLE', 'Kho trả sai orderId', 503);
  }

  /** Đọc snapshot kho theo orderId; worker không suy đoán kết quả từ timeout của deduct. */
  async state(orderId: string): Promise<StockOrderStateResponse> {
    const base = this.config.get('INVENTORY_URL', { infer: true });
    const response = await callInternal({
      url: `${base.replace(/\/$/, '')}/internal/stock/orders/${orderId}`,
      timeoutMs: 3000,
    });
    const state = stockOrderStateResponseSchema.parse(response);
    if (state.orderId !== orderId) {
      throw new BusinessError('SERVICE_UNAVAILABLE', 'Kho trả sai orderId', 503);
    }
    return state;
  }

  /** Cả ba POST đều gọi lặp an toàn; correlationId được HTTP client chung chuyển tiếp. */
  private post(action: string, body: unknown): Promise<unknown> {
    const base = this.config.get('INVENTORY_URL', { infer: true });
    return callInternal({
      url: `${base.replace(/\/$/, '')}/internal/stock/${action}`,
      method: 'POST',
      body,
      timeoutMs: 3000,
      idempotent: true,
    });
  }

  /** Phản hồi trùng/thiếu mã tem là lỗi giao thức, không cho tạo hoá đơn thiếu dòng. */
  private assertTagSet(tagCodes: string[], order: OrderRecord): void {
    const actual = [...tagCodes].sort();
    if (JSON.stringify(actual) !== JSON.stringify(order.requestedTagCodes)) {
      throw new BusinessError('SERVICE_UNAVAILABLE', 'Kho trả danh sách mã tem không khớp', 503);
    }
  }
}
