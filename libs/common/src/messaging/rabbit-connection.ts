import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { Logger } from '@nestjs/common';

const HEARTBEAT_SECONDS = 15;
const CONFIRM_TIMEOUT_MS = 5_000;
const CHANNEL_REOPEN_DELAY_MS = 1_000;

/** Mất kết nối tới broker: không phải lỗi của thư, thử lại sau không tính là một lần thất bại. */
export class RabbitUnavailableError extends Error {}

/** Broker nhận nhưng không queue nào nhận thư (`mandatory`). Thường là thiếu binding. */
export class UnroutableMessageError extends Error {}

export interface PublishRequest {
  exchange: string;
  routingKey: string;
  content: Buffer;
  messageId: string;
  headers?: Record<string, unknown>;
  /** Chỉ dùng để rút thời gian chờ retry trong test. */
  expirationMs?: number;
}

/** Hàm chạy lại sau mỗi lần kết nối hoặc khi kênh của nó bị đóng. */
export type ConnectionSetup = (model: ChannelModel) => Promise<void>;

interface RecoveringConnection {
  on(event: string, listener: (...args: never[]) => void): unknown;
  close(): Promise<void>;
}

/**
 * Một kết nối RabbitMQ cho cả service. Tự kết nối lại bằng `recovery` của amqplib; chỉ mở kênh và subscribe,
 * KHÔNG khai báo queue/exchange vì user ứng dụng không có quyền `configure`.
 */
export class RabbitConnection {
  private readonly logger = new Logger(RabbitConnection.name);
  private readonly setups: ConnectionSetup[] = [];
  private readonly returned = new Set<string>();
  private connection?: RecoveringConnection;
  private confirmChannel?: ConfirmChannel;
  private model?: ChannelModel;
  private connected = false;
  private stopping = false;

  constructor(private readonly url: string) {}

  /** Đã kết nối và có kênh gửi. */
  get isConnected(): boolean {
    return this.connected && this.confirmChannel !== undefined;
  }

  /** Đăng ký consumer; chạy ngay nếu đang có kết nối, và chạy lại sau mỗi lần kết nối lại. */
  async addSetup(setup: ConnectionSetup): Promise<void> {
    this.setups.push(setup);
    if (this.model !== undefined && this.connected) {
      await setup(this.model);
    }
  }

  /** Không chờ kết nối: broker chưa lên thì service vẫn chạy và `/health/ready` báo 503. */
  async start(): Promise<void> {
    const url = new URL(this.url);
    url.searchParams.set('heartbeat', String(HEARTBEAT_SECONDS));
    const connection = (await connect(url.toString(), {
      recovery: {
        waitForConnect: false,
        initialDelay: 500,
        maxDelay: 5_000,
        factor: 2,
        jitter: 0.2,
        setup: (model: ChannelModel) => this.onConnected(model),
      },
    })) as unknown as RecoveringConnection;
    this.connection = connection;
    connection.on('disconnect', ((error: Error) => {
      this.connected = false;
      this.confirmChannel = undefined;
      this.model = undefined;
      this.logger.warn(`Mất kết nối RabbitMQ: ${error.message}`);
    }) as never);
    connection.on('connect-failed', ((error: Error) => {
      this.logger.warn(`Không kết nối được RabbitMQ: ${error.message}`);
    }) as never);
    connection.on('error', ((error: Error) => {
      this.logger.warn(`Lỗi kết nối RabbitMQ: ${error.message}`);
    }) as never);
  }

  private async onConnected(model: ChannelModel): Promise<void> {
    this.model = model;
    await this.openConfirmChannel(model);
    for (const setup of this.setups) {
      await setup(model);
    }
    this.connected = true;
    this.logger.log('Đã kết nối RabbitMQ');
  }

  private async openConfirmChannel(model: ChannelModel): Promise<void> {
    const channel = await model.createConfirmChannel();
    channel.on('error', (error: Error) => {
      this.logger.warn(`Lỗi kênh gửi RabbitMQ: ${error.message}`);
    });
    channel.on('return', (message: { properties: { messageId?: string } }) => {
      const id = message.properties.messageId;
      if (id !== undefined) {
        this.returned.add(id);
      }
    });
    channel.on('close', () => {
      this.confirmChannel = undefined;
      // Kênh có thể đóng riêng lẻ khi kết nối còn sống (ví dụ gửi tới exchange không tồn tại).
      if (!this.stopping && this.model === model) {
        setTimeout(() => {
          this.openConfirmChannel(model).catch((error: unknown) => {
            this.logger.warn(`Không mở lại được kênh gửi: ${String(error)}`);
          });
        }, CHANNEL_REOPEN_DELAY_MS);
      }
    });
    this.confirmChannel = channel;
  }

  /**
   * Gửi `persistent` + `mandatory` và chờ publisher confirm. Thư không queue nào nhận vẫn được broker ack,
   * nên phải kiểm tra thêm sự kiện `return` (broker luôn gửi `return` trước `ack`).
   */
  async publish(request: PublishRequest): Promise<void> {
    const channel = this.confirmChannel;
    if (!this.connected || channel === undefined) {
      throw new RabbitUnavailableError('Chưa kết nối RabbitMQ');
    }
    const { exchange, routingKey, content, messageId, headers, expirationMs } = request;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new RabbitUnavailableError('Quá thời gian chờ publisher confirm')),
        CONFIRM_TIMEOUT_MS,
      );
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        if (error) {
          reject(this.connected ? error : new RabbitUnavailableError(String(error)));
        } else {
          resolve();
        }
      };
      try {
        channel.publish(
          exchange,
          routingKey,
          content,
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            messageId,
            headers,
            ...(expirationMs === undefined ? {} : { expiration: String(expirationMs) }),
          },
          finish,
        );
      } catch (error) {
        clearTimeout(timer);
        reject(new RabbitUnavailableError(String(error)));
      }
    });
    if (this.returned.delete(messageId)) {
      throw new UnroutableMessageError(`Không queue nào nhận thư ${messageId} (${routingKey})`);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    await this.connection?.close().catch(() => undefined);
    this.connection = undefined;
    this.confirmChannel = undefined;
    this.model = undefined;
  }

  /** Điểm gọi ack duy nhất. */
  ack(channel: { ack(message: never): void }, message: unknown): void {
    channel.ack(message as never);
  }

  /** Thời gian chờ trước khi mở lại kênh của consumer. */
  static readonly channelReopenDelayMs = CHANNEL_REOPEN_DELAY_MS;
}

/** Kiểm tra cho `/health/ready`. */
export function rabbitCheck(rabbit: Pick<RabbitConnection, 'isConnected'>) {
  return {
    name: 'rabbitmq',
    check: async (): Promise<void> => {
      if (!rabbit.isConnected) {
        throw new RabbitUnavailableError('Chưa kết nối RabbitMQ');
      }
    },
  };
}
