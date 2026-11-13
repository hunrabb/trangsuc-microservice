import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeHoldsService } from './exchange-holds.service';

@Injectable()
export class ExchangeExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly log = new Logger(ExchangeExpiryWorker.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly holds: ExchangeHoldsService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.scan(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async scan() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.prisma.exchangeHold.findMany({
        where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
        orderBy: { expiresAt: 'asc' },
        take: 50,
        select: { exchangeId: true },
      });
      for (const row of rows) {
        try {
          await this.holds.expire(row.exchangeId);
        } catch (error) {
          this.log.warn(`Exchange expiry ${row.exchangeId}: ${String(error)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
