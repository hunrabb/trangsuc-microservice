import { reviewExpiredPaidHold } from './payment-events';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { runWithLockRetry } from '@jewelry/common';
import { PrismaService } from '../prisma/prisma.service';
import { releaseOnlineOrder } from './reservations';

/** Dùng cùng khoá với consumer; lượt quét sau tiếp tục nếu rollback hoặc restart. */
@Injectable()
export class ReservationExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(ReservationExpiryWorker.name);
  constructor(private readonly prisma: PrismaService) {}
  onModuleInit(): void {
    this.timer = setInterval(() => void this.scan(), 60_000);
    this.timer.unref();
    void this.scan();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
  async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // SKIP LOCKED phân công tối đa 50 đơn/lượt giữa các instance.
      for (let n = 0; n < 50; n++) {
        const processed = await runWithLockRetry(() =>
          this.prisma.$transaction(async (tx) => {
            const [row] = await tx.$queryRaw<{ orderId: string; status: string }[]>`
            SELECT "orderId", status FROM "inventory"."StockReservation" WHERE status IN ('ACTIVE', 'PAID_HELD') AND "expiresAt" <= clock_timestamp()
            ORDER BY "expiresAt", id LIMIT 1 FOR UPDATE SKIP LOCKED`;
            if (!row) return false;
            if (row.status === 'PAID_HELD') await reviewExpiredPaidHold(tx, row.orderId);
            else await releaseOnlineOrder(tx, row.orderId, 'EXPIRED');
            return true;
          }),
        );
        if (!processed) break;
      }
    } catch (error) {
      this.logger.warn(`Chưa quét hết reservation quá hạn: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
