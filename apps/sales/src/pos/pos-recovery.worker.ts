import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OrderStore } from '../core/order-store';
import { PosOrdersService } from './pos-orders.service';

/** Quét lô nhỏ mỗi 30 giây; lease DB phân công giữa nhiều Sales instance sau crash hoặc timeout. */
@Injectable()
export class PosRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PosRecoveryWorker.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly store: OrderStore,
    private readonly orders: PosOrdersService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.scan(), 30_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** Chỉ xét đơn quá lease; lỗi một đơn không chặn các đơn khác trong lô. */
  async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.store.listExpiredOperations();
      for (const candidate of candidates) {
        try {
          await this.orders.recoverExpired(candidate.id);
        } catch (error) {
          this.logger.warn(`Chưa phục hồi được đơn ${candidate.id}: ${String(error)}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Chưa quét được đơn POS kẹt: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
