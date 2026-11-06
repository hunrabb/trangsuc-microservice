import {
  type DynamicModule,
  Global,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ConsumerDb, EventConsumer, type EventHandler } from './consumer';
import { type OutboxDb, OutboxWorker } from './outbox-worker';
import { RabbitConnection } from './rabbit-connection';

export interface MessagingOptions {
  /** Tên service, cũng là tên consumer trong `ProcessedEvent`. */
  service: string;
  /** Schema Postgres của service. */
  dbSchema: string;
  /** Provider Prisma của app. `libs/` không import Prisma client. */
  inject: (new (...args: never[]) => unknown)[];
  database: (...deps: never[]) => unknown;
  /** Bỏ trống nếu service chưa nhận sự kiện nào; khi đó chỉ chạy worker outbox. */
  consumer?: { queue: string; handlers: Partial<Record<string, EventHandler<never>>> };
}

const MESSAGING_DB = Symbol('MESSAGING_DB');
const MESSAGING_OPTIONS = Symbol('MESSAGING_OPTIONS');

/** Thứ tự tắt quan trọng: ngừng nhận thư, xong việc đang làm, rồi mới đóng kết nối. */
@Injectable()
class MessagingLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    private readonly rabbit: RabbitConnection,
    private readonly worker: OutboxWorker,
    @Optional() private readonly consumer?: EventConsumer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer?.start();
    await this.rabbit.start();
    this.worker.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
    await this.worker.stop();
    await this.rabbit.stop();
  }
}

/** Kết nối RabbitMQ, worker outbox và consumer (nếu có) của một service. Export `RabbitConnection` cho health. */
@Global()
@Module({})
export class MessagingModule {
  static forRoot(options: MessagingOptions): DynamicModule {
    return {
      module: MessagingModule,
      providers: [
        { provide: MESSAGING_OPTIONS, useValue: options },
        { provide: MESSAGING_DB, inject: options.inject, useFactory: options.database },
        {
          provide: RabbitConnection,
          inject: [ConfigService],
          useFactory: (config: ConfigService) =>
            new RabbitConnection(config.getOrThrow<string>('RABBITMQ_URL')),
        },
        {
          provide: OutboxWorker,
          inject: [MESSAGING_DB, RabbitConnection],
          useFactory: (db: OutboxDb, rabbit: RabbitConnection) =>
            new OutboxWorker({ db, rabbit, dbSchema: options.dbSchema }),
        },
        ...(options.consumer === undefined
          ? []
          : [
              {
                provide: EventConsumer,
                inject: [MESSAGING_DB, RabbitConnection],
                useFactory: (db: ConsumerDb, rabbit: RabbitConnection) =>
                  new EventConsumer({
                    db,
                    rabbit,
                    queue: options.consumer!.queue,
                    consumer: options.service,
                    handlers: options.consumer!.handlers as never,
                  }),
              },
            ]),
        MessagingLifecycle,
      ],
      exports: [RabbitConnection],
    };
  }
}
