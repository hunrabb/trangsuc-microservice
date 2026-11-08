import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { type AuthUser } from '@jewelry/common';
import type { CreatePosOrderRequest, PosOrder } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import {
  creationFailure,
  invalidOrderState,
  orderBusy,
  type OrderRecord,
  presentOrder,
  throwCreationFailure,
} from '../core/order-record';
import { OrderStore } from '../core/order-store';
import { InventoryStockClient } from './inventory-stock.client';

/** Điều phối POS ngoài transaction; store chỉ giữ khoá trong từng lần ghi ngắn. */
@Injectable()
export class PosOrdersService {
  constructor(
    private readonly store: OrderStore,
    private readonly inventory: InventoryStockClient,
  ) {}

  /** Cùng key dùng cùng dòng Order; request song song chờ chủ lease rồi nhận cùng id và snapshot. */
  async create(user: AuthUser, key: string, body: CreatePosOrderRequest): Promise<PosOrder> {
    const order = await this.store.open(user, key, body);
    return presentOrder(await this.settle(user, order.id));
  }

  /** Trả trạng thái bền vững sau reload/timeout, không tiếp quản hay gọi HTTP Inventory. */
  async getById(user: AuthUser, orderId: string): Promise<PosOrder> {
    return presentOrder(await this.store.load(user, orderId));
  }

  /** Key được giữ ở trình duyệt để truy tìm đơn khi phản hồi tạo đơn bị mất. */
  async getByKey(user: AuthUser, key: string): Promise<PosOrder> {
    return presentOrder(await this.store.loadByKey(user, key));
  }

  /** Chỉ xác nhận đơn chờ trả tiền trong chi nhánh được phép; lần thứ hai không có tác dụng phụ. */
  async confirmPayment(user: AuthUser, orderId: string): Promise<PosOrder> {
    const order = await this.store.load(user, orderId);
    return presentOrder(await this.store.confirmPayment(order, user.id));
  }

  /** Giành CANCELLING trước release; đơn đã trả tiền nhận 409 và không gọi inventory. */
  async cancel(user: AuthUser, orderId: string): Promise<PosOrder> {
    const order = await this.store.load(user, orderId);
    if (order.status === 'PENDING_PAYMENT') {
      await this.store.beginCancellation(order, user.id);
    } else if (order.status !== 'CANCELLING' || order.failureCode !== null) {
      throw invalidOrderState();
    }
    return presentOrder(await this.settle(user, orderId));
  }

  /** Poll có hạn, không giữ connection khi chờ; lease quá hạn được request mới tiếp quản sau crash. */
  private async settle(user: AuthUser, orderId: string): Promise<OrderRecord> {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const order = await this.store.load(user, orderId);
      if (order.status !== 'CREATING' && order.status !== 'CANCELLING') {
        throwCreationFailure(order);
        return order;
      }
      const owner = randomUUID();
      if (await this.store.claim(orderId, owner)) {
        try {
          await this.performStep(user, await this.store.load(user, orderId), owner);
        } finally {
          await this.store.releaseClaim(orderId, owner);
        }
      } else {
        await sleep(50);
      }
    }
    throw orderBusy();
  }

  /** Tiếp tục bước đã ghi trong DB; huỷ dở luôn release trước, tuyệt đối không trừ kho lại. */
  private async performStep(user: AuthUser, order: OrderRecord, owner: string): Promise<void> {
    if (order.status === 'CREATING') {
      await this.createWithInventory(order, owner);
    } else if (order.status === 'CANCELLING') {
      await this.inventory.release(order.id);
      await this.store.finishCancellation(order, owner, user.id);
    }
  }

  /** Giá cuối đến từ deduct; thất bại chuyển sang bước bù trừ trước khi nhả lease cho request khác. */
  private async createWithInventory(order: OrderRecord, owner: string): Promise<void> {
    try {
      if (!order.deductionStarted) {
        await this.inventory.quote(order);
        await this.store.markDeductionStarted(order.id, owner);
      }
      const deducted = await this.inventory.deduct(order);
      await this.store.finishCreation(order, owner, deducted);
    } catch (error) {
      await this.store.beginCancellation(
        order,
        order.createdBy,
        creationFailure(error, order.requestedTagCodes),
        owner,
      );
    }
  }
}
