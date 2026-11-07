import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface RefreshTokenTable {
  refreshToken: {
    deleteMany(args: {
      where: { OR: ({ revokedAt: { lt: Date } } | { expiresAt: { lt: Date } })[] };
    }): Promise<{ count: number }>;
  };
}

/** Xoá token đã thu hồi hoặc đã hết hạn quá 30 ngày. Token còn hiệu lực không khớp cả hai điều kiện. */
export async function deleteStaleRefreshTokens(
  db: RefreshTokenTable,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  const { count } = await db.refreshToken.deleteMany({
    where: { OR: [{ revokedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }] },
  });
  return count;
}

/** Nhiều instance cùng chạy cũng không sao: câu DELETE lặp lại không có tác dụng phụ. */
@Injectable()
export class RefreshTokenCleanupJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefreshTokenCleanupJob.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.run(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    try {
      const count = await deleteStaleRefreshTokens(this.prisma);
      if (count > 0) {
        this.logger.log(`Đã xoá ${count} refresh token cũ`);
      }
    } catch (error) {
      this.logger.warn(`Dọn refresh token lỗi: ${String(error)}`);
    }
  }
}
