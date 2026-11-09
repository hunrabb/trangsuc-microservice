import { recoverOnlinePayment } from '../payments/payment-recovery';
import { ONLINE_RECOVERY_RETRY_MS } from '@jewelry/contracts';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { emitOnlineCreated, cancelOnline } from './online-orders.service';

@Injectable()
export class OnlineRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(OnlineRecoveryWorker.name);
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
      for (let n = 0; n < 50; n++) {
        const processed = await this.prisma.$transaction(async (tx) => {
          const [candidate] = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "sales"."OnlineOrder" WHERE status IN ('PENDING','AWAITING_PAYMENT','PAYMENT_PROCESSING') AND "recoveryAfter" <= clock_timestamp()
            ORDER BY "recoveryAfter",id LIMIT 1 FOR UPDATE SKIP LOCKED`;
          if (!candidate) return false;
          const row = await tx.onlineOrder.findUniqueOrThrow({ where: { id: candidate.id } });
          const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          if (row.status === 'PAYMENT_PROCESSING') {
            await recoverOnlinePayment(tx, row, clock!.now);
          } else if (
            row.deadlineAt <= clock!.now ||
            (row.expiresAt !== null && row.expiresAt <= clock!.now)
          ) {
            await cancelOnline(tx, row, 'RESERVATION_EXPIRED');
          } else if (row.status === 'PENDING') {
            await tx.onlineOrder.update({
              where: { id: row.id },
              data: {
                needsReview: true,
                recoveryAfter: new Date(clock!.now.getTime() + ONLINE_RECOVERY_RETRY_MS),
              },
            });
            await emitOnlineCreated(tx, row);
          }
          return true;
        });
        if (!processed) break;
      }
    } catch (error) {
      this.logger.warn(`Chưa phục hồi hết đơn online: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
