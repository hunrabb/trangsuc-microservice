import { ConfigService } from '@jewelry/common';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { DB_SCHEMA, type Env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Prisma client của riêng service này. Kết nối mở khi có truy vấn đầu tiên: Postgres chưa sẵn sàng thì
 * service vẫn lên và `/health/ready` trả 503, Postgres quay lại thì tự hồi phục.
 * `schema` phải truyền ở đây: adapter-pg không đọc `?schema=` trong URL.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    const connectionString = config.get('DATABASE_URL', { infer: true });
    super({ adapter: new PrismaPg({ connectionString }, { schema: DB_SCHEMA }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
