import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BuybackSettlementService } from './buyback-settlement.service';

@Injectable()
export class BuybackSettlementRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly log = new Logger(BuybackSettlementRecoveryWorker.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: BuybackSettlementService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.scan(), 30_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async scan() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.prisma.buybackSettlement.findMany({
        where: {
          status: { in: ['RESERVING', 'CANCELLING', 'FULFILLING', 'RECONCILIATION_REQUIRED'] },
          recoveryAttempts: { lt: 5 },
          updatedAt: { lt: new Date(Date.now() - 30_000) },
        },
        orderBy: { updatedAt: 'asc' },
        take: 20,
        select: { id: true },
      });
      for (const row of rows) {
        try {
          await this.service.recover(row.id);
        } catch (error) {
          this.log.warn(`Exchange recovery ${row.id}: ${String(error)}`);
        }
      }
      const missing = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT settlement.id FROM "sales"."BuybackSettlement" settlement
        WHERE settlement.status = 'SETTLED'
          AND NOT EXISTS (SELECT 1 FROM "sales"."OutboxEvent" event
            WHERE event."aggregateId" = settlement.id AND event."eventType" = 'buyback.settled')
        ORDER BY settlement."createdAt" ASC LIMIT 20`;
      for (const row of missing) {
        try {
          await this.service.ensureStockEvent(row.id);
        } catch (error) {
          this.log.warn(`Buyback stock event ${row.id}: ${String(error)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
