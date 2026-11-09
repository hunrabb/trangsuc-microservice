// Hạ tầng thật: Postgres + RabbitMQ của Docker Compose (`docker compose up -d postgres rabbitmq rabbitmq-setup`).
// Đọc mật khẩu từ .env ở gốc, dùng đúng user ứng dụng như service thật.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { deadLetterQueueName, QUEUES, retryQueueName } from '@jewelry/contracts';
import {
  createTestKeys,
  signTestToken,
  TEST_AUDIENCE_BACKOFFICE,
  TEST_AUDIENCE_SHOP,
  TEST_ISSUER,
} from '@jewelry/test-utils';
import amqplib from 'amqplib';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(REPO_ROOT, '.env'));

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Thiếu ${name} trong .env`);
  }
  return value;
};

export const databaseUrl = (service: 'inventory' | 'report'): string =>
  `postgresql://${service}_user:${env(`${service.toUpperCase()}_DB_PASSWORD`)}@127.0.0.1:5432/${env('POSTGRES_DB')}?schema=${service}`;

export const RABBIT_URL = `amqp://${env('RABBITMQ_APP_USER')}:${env('RABBITMQ_APP_PASSWORD')}@127.0.0.1:5672`;

const MANAGEMENT_URL = 'http://127.0.0.1:15672/api';
const managementAuth = `Basic ${Buffer.from(`${env('RABBITMQ_ADMIN_USER')}:${env('RABBITMQ_ADMIN_PASSWORD')}`).toString('base64')}`;

/** Prisma client của app, lấy từ bản build. Package test không nằm trong luật cấm import xuyên app. */
export function prismaFor(service: 'inventory' | 'report'): TestDb {
  const appRequire = createRequire(resolve(REPO_ROOT, `apps/${service}/package.json`));
  const { PrismaPg } = appRequire('@prisma/adapter-pg');
  const { PrismaClient } = appRequire(`./dist/generated/prisma/client.js`);
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl(service) }, { schema: service }),
  }) as TestDb;
}

export interface TestDb {
  $transaction<T>(work: (tx: never) => Promise<T>): Promise<T>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $disconnect(): Promise<void>;
  outboxEvent: {
    groupBy(args: unknown): Promise<{ status: string; _count: { _all: number } }[]>;
    count(args?: unknown): Promise<number>;
    findUniqueOrThrow(
      args: unknown,
    ): Promise<{ status: string; attempts: number; nextAttemptAt: Date | null }>;
    findMany(args?: unknown): Promise<{ id: string; status: string; attempts: number }[]>;
    deleteMany(args?: unknown): Promise<unknown>;
  };
  processedEvent: {
    count(args?: unknown): Promise<number>;
    deleteMany(args?: unknown): Promise<unknown>;
  };
}

export function migrate(service: 'inventory' | 'report'): void {
  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(REPO_ROOT, `apps/${service}`),
    env: { ...process.env, DATABASE_URL: databaseUrl(service) },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy (${service}) lỗi: ${result.stdout}${result.stderr}`);
  }
}

async function management(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${MANAGEMENT_URL}${path}`, {
    ...init,
    headers: { authorization: managementAuth, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
}

const queuePath = (queue: string) => `/queues/%2F/${encodeURIComponent(queue)}`;

/** Mọi queue test có thể chạm tới. Không bao giờ purge: chỉ lấy đúng thư của test. */
export const TEST_QUEUES = [
  QUEUES.REPORT,
  retryQueueName(QUEUES.REPORT, 0),
  retryQueueName(QUEUES.REPORT, 1),
  retryQueueName(QUEUES.REPORT, 2),
  deadLetterQueueName(QUEUES.REPORT),
];

/** Đánh dấu thư do test tự gửi, kể cả thư cố tình hỏng không đọc được `eventType`. */
export const TEST_MESSAGE_HEADER = 'x-messaging-test';

/** Routing key chỉ test dùng; binding do test tự thêm rồi gỡ. */
export const TEST_ROUTING_KEY = 'test.requeue';

/** Thư của test: có dấu, hoặc là sự kiện của test do worker gửi (không có dấu). */
function isTestMessage(content: Buffer, headers: Record<string, unknown> | undefined): boolean {
  if (headers?.[TEST_MESSAGE_HEADER] !== undefined) {
    return true;
  }
  try {
    const { eventType, payload } = JSON.parse(content.toString('utf8')) as {
      eventType?: unknown;
      payload?: { tagCodes?: unknown };
    };
    if (eventType === 'system.test' || eventType === TEST_ROUTING_KEY) return true;
    // Chỉ nhận các POS event do test tự gắn mã tem, để không xoá thư thật của cửa hàng.
    return (
      ['order.paid', 'order.cancelled'].includes(String(eventType)) &&
      Array.isArray(payload?.tagCodes) &&
      payload.tagCodes.every((tag) => typeof tag === 'string' && tag.startsWith('POSTEST-'))
    );
  } catch {
    return false;
  }
}

async function withChannel<T>(work: (channel: amqplib.Channel) => Promise<T>): Promise<T> {
  const connection = await amqplib.connect(RABBIT_URL);
  try {
    const channel = await connection.createChannel();
    return await work(channel);
  } finally {
    await connection.close();
  }
}

const BINDING_PATH = `/bindings/%2F/e/domain.events/q/${QUEUES.REPORT}`;

export async function addTestBinding(): Promise<void> {
  const response = await management(BINDING_PATH, {
    method: 'POST',
    body: JSON.stringify({ routing_key: TEST_ROUTING_KEY }),
  });
  if (!response.ok) {
    throw new Error(`Không thêm được binding: HTTP ${response.status}`);
  }
}

/** Gỡ binding của test; chưa có thì thôi. */
export async function removeTestBinding(): Promise<void> {
  await management(`${BINDING_PATH}/${TEST_ROUTING_KEY}`, { method: 'DELETE' });
}

export async function eventBindings(): Promise<string[]> {
  const response = await management('/bindings/%2F');
  const bindings = (await response.json()) as {
    source: string;
    routing_key: string;
    destination: string;
  }[];
  return bindings
    .filter((binding) => binding.source === 'domain.events')
    .map((binding) => `${binding.routing_key}→${binding.destination}`)
    .sort();
}

/** Chạy đúng lệnh người vận hành dùng, kèm kết quả in ra. */
export function outboxRequeue(...args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('pnpm', ['-s', 'outbox:requeue', '--', '--service', 'report', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl('report') },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export interface QueueState {
  messages: number;
  consumers: number;
}

/** Số thư và consumer thời gian thực; thống kê của management API trễ vài giây. */
export function queueStates(): Promise<Record<string, QueueState>> {
  return withChannel(async (channel) => {
    const states: Record<string, QueueState> = {};
    for (const queue of TEST_QUEUES) {
      const { messageCount, consumerCount } = await channel.checkQueue(queue);
      states[queue] = { messages: messageCount, consumers: consumerCount };
    }
    return states;
  });
}

/**
 * Lấy khỏi queue đúng các thư của test, từng thư một. Gặp thư lạ thì trả nguyên về queue rồi báo lỗi.
 * Trả về số thư đã lấy.
 */
export function drainTestMessages(): Promise<number> {
  return withChannel(async (channel) => {
    let drained = 0;
    for (const queue of TEST_QUEUES) {
      for (;;) {
        const message = await channel.get(queue, { noAck: false });
        if (message === false) {
          break;
        }
        if (!isTestMessage(message.content, message.properties.headers)) {
          channel.nack(message, false, true);
          throw new Error(`Queue ${queue} có thư không phải của test, đã trả lại và dừng`);
        }
        channel.ack(message);
        drained += 1;
      }
    }
    return drained;
  });
}

/** Xem toàn bộ queue, chỉ đọc. Dùng trước khi động tới bất cứ thứ gì. */
export async function findForeignMessages(): Promise<string[]> {
  const foreign: string[] = [];
  for (const queue of TEST_QUEUES) {
    for (const message of await peekQueue(queue, 10_000)) {
      if (!isTestMessage(Buffer.from(message.payload), message.properties.headers)) {
        foreign.push(`${queue}: ${message.payload.slice(0, 80)}`);
      }
    }
  }
  return foreign;
}

export interface PeekedMessage {
  payload: string;
  properties: { message_id?: string; headers?: Record<string, unknown> };
}

/** Xem thư trong queue mà không lấy đi. */
export async function peekQueue(queue: string, count = 50): Promise<PeekedMessage[]> {
  const response = await management(`${queuePath(queue)}/get`, {
    method: 'POST',
    body: JSON.stringify({ count, ackmode: 'ack_requeue_true', encoding: 'auto' }),
  });
  return (await response.json()) as PeekedMessage[];
}

/** Bất đồng bộ: không được chặn event loop, worker và consumer phải chạy thật trong lúc broker tắt. */
export function compose(...args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn('docker', ['compose', ...args], { cwd: REPO_ROOT, stdio: 'ignore' });
    child.once('error', fail);
    child.once('close', (code) =>
      code === 0 ? done() : fail(new Error(`docker compose ${args.join(' ')} thoát mã ${code}`)),
    );
  });
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let met = false;
    try {
      met = await condition();
    } catch {
      // chưa sẵn sàng
    }
    if (met) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Quá ${timeoutMs} ms chờ: ${label}`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

export interface LogLine {
  service?: string;
  correlationId?: string | null;
  msg?: string;
}

export interface RunningService {
  child: ChildProcess;
  logs: LogLine[];
  port: number;
}

const keys = createTestKeys();

/** Token ký bằng cùng khoá tạm mà hai service test đang dùng. */
export function testToken(role: 'ADMIN' | 'MANAGER' | 'STAFF', branchId: string | null) {
  return signTestToken(keys.privateKey, {
    claims: { branches: [{ role, branchId }] },
  });
}

/** Chạy bản build thật của service. */
export async function startService(service: 'inventory' | 'report'): Promise<RunningService> {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(REPO_ROOT, `apps/${service}/dist/main.js`)], {
    cwd: import.meta.dirname,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: databaseUrl(service),
      RABBITMQ_URL: RABBIT_URL,
      DATABASE_POOL_MAX: '20',
      JWT_PUBLIC_KEY_PATH: keys.publicKeyPath,
      JWT_ISSUER: TEST_ISSUER,
      JWT_AUDIENCE_BACKOFFICE: TEST_AUDIENCE_BACKOFFICE,
      JWT_AUDIENCE_SHOP: TEST_AUDIENCE_SHOP,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const logs: LogLine[] = [];
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() !== '') {
        logs.push(JSON.parse(line) as LogLine);
      }
    }
  });
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/health/ready`)).ok,
    30_000,
    `${service} sẵn sàng`,
  );
  return { child, logs, port };
}
