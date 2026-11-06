// Chạy tuần tự trên Postgres + RabbitMQ thật: pnpm test:messaging
//
// Chạy được trên hạ tầng đang có dữ liệu: không deleteMany cả bảng, không purge queue. Trước khi chạy, thấy
// dữ liệu không phải của test mà test có thể đụng tới thì dừng và báo lỗi; chạy xong, trạng thái phải y như trước.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  type EventConsumerOptions,
  EventConsumer,
  outbox,
  OutboxWorker,
  type OutboxTx,
  PermanentError,
  RabbitConnection,
  runWithCorrelationId,
  TransientError,
} from '@jewelry/common';
import {
  deadLetterQueueName,
  EVENTS_EXCHANGE,
  MESSAGE_HEADERS,
  QUEUES,
  retryQueueName,
  ROUTING_KEYS,
} from '@jewelry/contracts';
import { Logger } from '@nestjs/common';
import {
  addTestBinding,
  compose,
  drainTestMessages,
  eventBindings,
  findForeignMessages,
  migrate,
  outboxRequeue,
  peekQueue,
  prismaFor,
  queueStates,
  RABBIT_URL,
  removeTestBinding,
  type RunningService,
  sleep,
  startService,
  TEST_MESSAGE_HEADER,
  TEST_ROUTING_KEY,
  type TestDb,
  waitFor,
} from './support.ts';

const QUEUE = QUEUES.REPORT;
const DLQ = deadLetterQueueName(QUEUE);
const TEST_AGGREGATE = 'test';
const TEST_CONSUMER = 'test';
const TEST_ROWS = { where: { aggregateType: TEST_AGGREGATE } };
const TEST_PROCESSED = { where: { consumer: TEST_CONSUMER } };
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type Tx = OutboxTx & { $executeRawUnsafe(query: string): Promise<number> };
type Handler = (payload: { message: string }, context: { tx: Tx }) => Promise<void>;

describe('outbox + consumer trên hạ tầng thật', () => {
  let db: TestDb;
  let inventoryDb: TestDb;
  let before_: unknown;
  const cleanups: (() => Promise<void>)[] = [];
  /** eventId mà service thật (`report`) đã ghi vào `ProcessedEvent` trong test. */
  const reportProcessed: string[] = [];

  const removeTestData = async () => {
    await drainTestMessages();
    await db.outboxEvent.deleteMany(TEST_ROWS);
    await inventoryDb.outboxEvent.deleteMany(TEST_ROWS);
    await db.processedEvent.deleteMany(TEST_PROCESSED);
    await db.processedEvent.deleteMany({
      where: { consumer: 'report', eventId: { in: reportProcessed } },
    });
  };

  const snapshot = async () => {
    const count = async (client: TestDb) =>
      (await client.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }))
        .map((group) => `${group.status}=${group._count._all}`)
        .sort();
    return {
      queues: await queueStates(),
      bindings: await eventBindings(),
      reportOutbox: await count(db),
      inventoryOutbox: await count(inventoryDb),
      reportProcessed: await db.processedEvent.count(TEST_PROCESSED),
    };
  };

  /** Dừng trước khi đụng vào bất cứ thứ gì nếu test có thể làm hỏng dữ liệu không phải của nó. */
  const assertSafeToRun = async () => {
    const problems: string[] = [];
    for (const [queue, state] of Object.entries(await queueStates())) {
      if (state.consumers > 0) {
        problems.push(`${queue} đang có ${state.consumers} consumer (service nào đó đang chạy?)`);
      }
    }
    problems.push(...(await findForeignMessages()).map((line) => `thư lạ ở ${line}`));
    const staleBefore = new Date(Date.now() - RETENTION_MS);
    for (const [name, client] of [
      ['report', db],
      ['inventory', inventoryDb],
    ] as const) {
      // Worker trong test nhận mọi dòng chờ gửi, và job dọn xoá mọi dòng đã gửi quá hạn.
      const foreign = await client.outboxEvent.count({
        where: {
          aggregateType: { not: TEST_AGGREGATE },
          OR: [
            { status: { in: ['PENDING', 'PROCESSING'] } },
            { status: 'PUBLISHED', publishedAt: { lt: staleBefore } },
          ],
        },
      });
      if (foreign > 0) {
        problems.push(
          `${name}.OutboxEvent có ${foreign} dòng thật mà worker hoặc job dọn sẽ đụng tới`,
        );
      }
    }
    if (problems.length > 0) {
      throw new Error(`Dừng, không chạy test messaging:\n- ${problems.join('\n- ')}`);
    }
  };

  before(async () => {
    Logger.overrideLogger(false);
    migrate('report');
    migrate('inventory');
    db = prismaFor('report');
    inventoryDb = prismaFor('inventory');
    await assertSafeToRun();
    await removeTestData(); // phần còn sót nếu lần chạy trước bị ngắt
    await removeTestBinding();
    before_ = await snapshot();
  });

  after(async () => {
    try {
      await removeTestData();
      assert.deepEqual(await snapshot(), before_, 'hệ thống phải giống hệt trước khi chạy');
    } finally {
      await db.$disconnect();
      await inventoryDb.$disconnect();
    }
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    await removeTestData();
  });

  const connect = async (rabbit = new RabbitConnection(RABBIT_URL)) => {
    await rabbit.start();
    cleanups.push(() => rabbit.stop());
    await waitFor(() => rabbit.isConnected, 30_000, 'kết nối RabbitMQ');
    return rabbit;
  };

  const startConsumer = async (
    handler: Handler,
    rabbit: RabbitConnection,
    options: Partial<EventConsumerOptions> = {},
  ) => {
    const consumer = new EventConsumer({
      rabbit,
      db: db as never,
      queue: QUEUE,
      consumer: TEST_CONSUMER,
      handlers: { [ROUTING_KEYS.SYSTEM_TEST]: handler as never },
      ...options,
    });
    await consumer.start();
    cleanups.push(() => consumer.stop());
    return consumer;
  };

  const newWorker = (
    rabbit: Pick<RabbitConnection, 'isConnected' | 'publish'>,
    options: { sendWindowMs?: number; backoffUnitMs?: number } = {},
  ) =>
    new OutboxWorker({ db: db as never, rabbit, dbSchema: 'report', intervalMs: 50, ...options });

  const startWorker = (rabbit: RabbitConnection) => {
    const worker = newWorker(rabbit);
    worker.start();
    cleanups.push(() => worker.stop());
    return worker;
  };

  const addEvent = (message = 'x') =>
    db.$transaction((tx: never) =>
      outbox.add(tx as OutboxTx, {
        eventType: ROUTING_KEYS.SYSTEM_TEST,
        aggregateType: TEST_AGGREGATE,
        aggregateId: randomUUID(),
        payload: { message },
      }),
    );

  const envelope = (eventId = randomUUID(), correlationId = randomUUID()) => ({
    eventId,
    eventType: ROUTING_KEYS.SYSTEM_TEST,
    occurredAt: new Date().toISOString(),
    correlationId,
    payload: { message: 'x' },
  });

  const publishRaw = (rabbit: RabbitConnection, body: unknown, messageId = randomUUID()) =>
    rabbit.publish({
      exchange: EVENTS_EXCHANGE,
      routingKey: ROUTING_KEYS.SYSTEM_TEST,
      content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      messageId,
      headers: { [MESSAGE_HEADERS.CORRELATION_ID]: 'tu-header', [TEST_MESSAGE_HEADER]: 'true' },
    });

  const emptyQueue = (queue: string) =>
    waitFor(async () => (await peekQueue(queue)).length === 0, 10_000, `${queue} rỗng`);

  it('đối chứng: commit thì thư tới đích', async () => {
    const rabbit = await connect();
    const seen: string[] = [];
    await startConsumer(async ({ message }) => void seen.push(message), rabbit);
    startWorker(rabbit);
    await addEvent('co-commit');
    await waitFor(() => seen.length === 1, 5_000, 'nhận thư');
    assert.deepEqual(seen, ['co-commit']);
  });

  it('ghi outbox rồi rollback: không có thư nào được gửi', async () => {
    const rabbit = await connect();
    const seen: string[] = [];
    await startConsumer(async ({ message }) => void seen.push(message), rabbit);
    startWorker(rabbit);

    await assert.rejects(
      db.$transaction(async (tx: never) => {
        await outbox.add(tx as OutboxTx, {
          eventType: ROUTING_KEYS.SYSTEM_TEST,
          aggregateType: TEST_AGGREGATE,
          aggregateId: randomUUID(),
          payload: { message: 'bi-rollback' },
        });
        throw new Error('huỷ transaction');
      }),
      /huỷ transaction/,
    );
    await sleep(500);

    assert.equal(await db.outboxEvent.count(TEST_ROWS), 0);
    assert.deepEqual(seen, []);
    assert.deepEqual(await peekQueue(QUEUE), []);
  });

  it('gửi trùng cùng eventId 3 lần: handler chạy đúng 1 lần, cả 3 thư được ack', async () => {
    const rabbit = await connect();
    let calls = 0;
    await startConsumer(async () => void (calls += 1), rabbit);
    const body = envelope();

    await publishRaw(rabbit, body, body.eventId);
    await publishRaw(rabbit, body, body.eventId);
    await publishRaw(rabbit, body, body.eventId);

    await waitFor(() => calls === 1, 5_000, 'xử lý');
    await sleep(500);
    await emptyQueue(QUEUE);
    assert.equal(calls, 1);
    assert.equal(await db.processedEvent.count(TEST_PROCESSED), 1);
    assert.deepEqual(await peekQueue(DLQ), []);
  });

  it('thư trùng tới song song trong prefetch: vẫn 1 lần', async () => {
    const rabbit = await connect();
    let calls = 0;
    await startConsumer(async () => {
      calls += 1;
      await sleep(100);
    }, rabbit);
    const body = envelope();
    await Promise.all(Array.from({ length: 8 }, () => publishRaw(rabbit, body, body.eventId)));

    await waitFor(() => calls >= 1, 5_000, 'xử lý');
    await sleep(800);
    await emptyQueue(QUEUE);
    assert.equal(await db.processedEvent.count(TEST_PROCESSED), 1);
    assert.deepEqual(await peekQueue(DLQ), []);
    assert.equal(calls, 1);
  });

  it('TransientError 2 lần rồi thành công: xử lý 1 lần, đúng thứ tự trễ', async () => {
    const rabbit = await connect();
    const attempts: number[] = [];
    await startConsumer(
      async (_payload, { tx }) => {
        attempts.push(Date.now());
        await tx.$executeRawUnsafe('SELECT 1');
        if (attempts.length <= 2) {
          throw new TransientError('đối tác bận');
        }
      },
      rabbit,
      { retryExpirationMs: [300, 900, 1500] },
    );
    const body = envelope();
    await publishRaw(rabbit, body, body.eventId);

    await waitFor(
      async () => (await db.processedEvent.count(TEST_PROCESSED)) === 1,
      10_000,
      'xử lý xong',
    );
    await emptyQueue(QUEUE);
    const [first = 0, second = 0, third = 0] = attempts;
    assert.equal(attempts.length, 3);
    assert.ok(second - first >= 280, `bậc 1 chờ ${second - first} ms`);
    assert.ok(third - second >= 880, `bậc 2 chờ ${third - second} ms`);
    assert.ok(third - second > second - first, 'bậc sau phải chờ lâu hơn bậc trước');
    assert.equal(await db.processedEvent.count(TEST_PROCESSED), 1);
    assert.deepEqual(await peekQueue(DLQ), []);
  });

  it('queue chờ thật: không rút TTL, thư quay lại sau đúng khoảng 5 giây', async () => {
    const rabbit = await connect();
    const attempts: number[] = [];
    await startConsumer(async () => {
      attempts.push(Date.now());
      if (attempts.length === 1) {
        throw new TransientError('đợi');
      }
    }, rabbit);
    const body = envelope();
    await publishRaw(rabbit, body, body.eventId);

    await waitFor(() => attempts.length === 1, 3_000, 'lần đầu');
    await waitFor(
      async () => (await peekQueue(retryQueueName(QUEUE, 0))).length === 1,
      2_000,
      'vào queue chờ',
    );
    await waitFor(() => attempts.length === 2, 8_000, 'quay lại');
    const waited = (attempts[1] ?? 0) - (attempts[0] ?? 0);
    assert.ok(waited >= 4_900 && waited < 7_000, `chờ ${waited} ms`);
  });

  it('hết lượt thử: sau 3 lần chờ thì vào DLQ, loại TRANSIENT', async () => {
    const rabbit = await connect();
    let calls = 0;
    await startConsumer(
      async () => {
        calls += 1;
        throw new TransientError('luôn hỏng');
      },
      rabbit,
      { retryExpirationMs: [50, 50, 50] },
    );
    const body = envelope();
    await publishRaw(rabbit, body, body.eventId);

    await waitFor(async () => (await peekQueue(DLQ)).length === 1, 10_000, 'vào DLQ');
    const [dead] = await peekQueue(DLQ);
    assert.equal(calls, 4);
    assert.equal(dead?.properties.headers?.[MESSAGE_HEADERS.ERROR_KIND], 'TRANSIENT');
    assert.equal(dead?.properties.headers?.[MESSAGE_HEADERS.RETRY_COUNT], 3);
    assert.equal(await db.processedEvent.count(TEST_PROCESSED), 0);
  });

  it('deadlock thật từ Postgres (40P01) được phân loại là tạm thời', async () => {
    const rabbit = await connect();
    let calls = 0;
    await startConsumer(
      async (_payload, { tx }) => {
        calls += 1;
        if (calls === 1) {
          await tx.$executeRawUnsafe(
            `DO $$ BEGIN RAISE EXCEPTION 'deadlock' USING ERRCODE = '40P01'; END $$`,
          );
        }
      },
      rabbit,
      { retryExpirationMs: [50, 50, 50] },
    );
    const body = envelope();
    await publishRaw(rabbit, body, body.eventId);

    await waitFor(
      async () => (await db.processedEvent.count(TEST_PROCESSED)) === 1,
      8_000,
      'thử lại thành công',
    );
    assert.equal(calls, 2);
    assert.deepEqual(await peekQueue(DLQ), []);
  });

  it('PermanentError: thư vào DLQ ngay, giữ nội dung, có lý do và correlationId', async () => {
    const rabbit = await connect();
    let calls = 0;
    await startConsumer(async () => {
      calls += 1;
      throw new PermanentError('không tìm thấy đơn');
    }, rabbit);
    const correlationId = randomUUID();
    const body = envelope(randomUUID(), correlationId);
    await publishRaw(rabbit, body, body.eventId);

    await waitFor(async () => (await peekQueue(DLQ)).length === 1, 5_000, 'vào DLQ');
    const [dead] = await peekQueue(DLQ);
    const headers = dead?.properties.headers ?? {};
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(dead?.payload ?? ''), body);
    assert.equal(dead?.properties.message_id, body.eventId);
    assert.match(String(headers[MESSAGE_HEADERS.ERROR_REASON]), /không tìm thấy đơn/);
    assert.equal(headers[MESSAGE_HEADERS.ERROR_KIND], 'PERMANENT');
    assert.equal(headers[MESSAGE_HEADERS.CORRELATION_ID], correlationId);
    assert.equal(headers[MESSAGE_HEADERS.FAILED_QUEUE], QUEUE);
    assert.equal(await db.processedEvent.count(TEST_PROCESSED), 0);
    await emptyQueue(QUEUE);
  });

  it('thư hỏng vào DLQ ngay, handler không chạy, correlationId lấy từ header', async () => {
    const rabbit = await connect();
    let calls = 0;
    await startConsumer(async () => void (calls += 1), rabbit, {
      handlers: {},
    });
    const cases: unknown[] = [
      'khong phai json',
      { eventId: 'x' },
      { ...envelope(), eventType: 'khong.co' },
      { ...envelope(), payload: { message: 123 } },
      envelope(), // sự kiện hợp lệ nhưng consumer này không có handler
    ];
    for (const body of cases) {
      await publishRaw(rabbit, body);
    }

    await waitFor(async () => (await peekQueue(DLQ)).length === cases.length, 5_000, 'vào DLQ');
    const dead = await peekQueue(DLQ);
    assert.equal(calls, 0);
    for (const message of dead) {
      const headers = message.properties.headers ?? {};
      assert.equal(headers[MESSAGE_HEADERS.ERROR_KIND], 'PERMANENT');
      assert.ok(String(headers[MESSAGE_HEADERS.ERROR_REASON]).length > 0);
    }
  });

  it('P2002 ở bảng khác trong handler không bị coi là đã xử lý: thư vào DLQ, không mất', async () => {
    const rabbit = await connect();
    const id = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "report"."OutboxEvent" (id, "eventType", "aggregateType", "aggregateId", payload, "correlationId", status)
       VALUES ($1::uuid, 'x', 'test', $1::uuid, '{}'::jsonb, 'x', 'PUBLISHED')`,
      id,
    );
    await startConsumer(async (_payload, { tx }) => {
      await tx.outboxEvent.create({
        data: {
          id,
          eventType: 'x',
          aggregateType: TEST_AGGREGATE,
          aggregateId: id,
          payload: {} as never,
          correlationId: 'x',
        },
      });
    }, rabbit);
    const body = envelope();
    await publishRaw(rabbit, body, body.eventId);

    await waitFor(async () => (await peekQueue(DLQ)).length === 1, 5_000, 'vào DLQ');
    assert.equal(await db.processedEvent.count(TEST_PROCESSED), 0);
  });

  it('sập sau commit, trước ack: thư được giao lại, handler không chạy lần hai', async () => {
    class CrashBeforeAck extends RabbitConnection {
      crashed = false;
      override ack(): void {
        this.crashed = true;
        void this.stop();
        throw new Error('sập trước khi ack');
      }
    }
    const crashing = new CrashBeforeAck(RABBIT_URL);
    await connect(crashing);
    let calls = 0;
    const handler: Handler = async () => void (calls += 1);
    await startConsumer(handler, crashing);
    const sender = await connect();
    const body = envelope();
    await publishRaw(sender, body, body.eventId);

    await waitFor(() => crashing.crashed, 5_000, 'sập');
    assert.equal(calls, 1);
    assert.equal(await db.processedEvent.count(TEST_PROCESSED), 1);
    await waitFor(async () => (await peekQueue(QUEUE)).length === 1, 10_000, 'thư còn trong queue');

    const restarted = await connect();
    await startConsumer(handler, restarted);
    await emptyQueue(QUEUE);
    assert.equal(calls, 1);
    assert.deepEqual(await peekQueue(DLQ), []);
  });

  it('hai worker song song: mỗi thư được gửi đúng một lần', async () => {
    const total = 300;
    for (let index = 0; index < total; index += 1) {
      await addEvent(`m${index}`);
    }
    const rabbitA = await connect();
    const rabbitB = await connect();
    const published: string[] = [];
    const spy = (rabbit: RabbitConnection) => ({
      get isConnected() {
        return rabbit.isConnected;
      },
      publish: async (request: Parameters<RabbitConnection['publish']>[0]) => {
        published.push(request.messageId);
        await rabbit.publish(request);
      },
    });
    const pending = () =>
      db.outboxEvent.count({
        where: { aggregateType: TEST_AGGREGATE, status: { not: 'PUBLISHED' } },
      });
    const drain = async (worker: OutboxWorker) => {
      while ((await pending()) > 0) {
        await worker.tick();
      }
    };

    await Promise.all([drain(newWorker(spy(rabbitA))), drain(newWorker(spy(rabbitB)))]);

    assert.equal(published.length, total);
    assert.equal(new Set(published).size, total);
    await waitFor(
      async () => (await peekQueue(QUEUE, total + 50)).length === total,
      10_000,
      `đủ ${total} thư trong queue`,
    );
  });

  it('gần hết thời gian giữ dòng: dừng gửi, phần chưa gửi về PENDING và được lô sau gửi', async () => {
    const ids = [await addEvent('a'), await addEvent('b'), await addEvent('c')];
    const rabbit = await connect();
    const published: string[] = [];
    const slow = {
      get isConnected() {
        return rabbit.isConnected;
      },
      publish: async (request: Parameters<RabbitConnection['publish']>[0]) => {
        published.push(request.messageId);
        await rabbit.publish(request);
        await sleep(80);
      },
    };

    await newWorker(slow, { sendWindowMs: 50 }).tick();

    assert.equal(published.length, 1);
    const rows = await db.outboxEvent.findMany(TEST_ROWS);
    assert.deepEqual(rows.map((row) => row.status).sort(), ['PENDING', 'PENDING', 'PUBLISHED']);
    assert.equal(Math.max(...rows.map((row) => row.attempts)), 0);
    const held = await db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) FROM "report"."OutboxEvent"
       WHERE "aggregateType" = 'test' AND status = 'PENDING' AND "lockedUntil" IS NOT NULL`,
    );
    assert.equal(Number(held[0]?.count), 0);

    // Lô sau gửi nốt, không thư nào bị gửi hai lần.
    await newWorker(slow).tick();
    assert.deepEqual([...published].sort(), [...ids].sort());
  });

  it('dòng kẹt PROCESSING quá lockedUntil được nhận lại; chưa quá hạn thì không', async () => {
    const rabbit = await connect();
    const seen: string[] = [];
    await startConsumer(async ({ message }) => void seen.push(message), rabbit);
    const expired = await addEvent('ket-qua-han');
    const locked = await addEvent('dang-giu');
    await db.$executeRawUnsafe(
      `UPDATE "report"."OutboxEvent" SET status = 'PROCESSING', "lockedUntil" = now() - interval '1 second' WHERE id = $1::uuid`,
      expired,
    );
    await db.$executeRawUnsafe(
      `UPDATE "report"."OutboxEvent" SET status = 'PROCESSING', "lockedUntil" = now() + interval '1 hour' WHERE id = $1::uuid`,
      locked,
    );

    await newWorker(rabbit).tick();

    await waitFor(() => seen.length === 1, 5_000, 'nhận thư');
    assert.deepEqual(seen, ['ket-qua-han']);
    const stillLocked = await db.outboxEvent.findUniqueOrThrow({ where: { id: locked } });
    assert.equal(stillLocked.status, 'PROCESSING');
    assert.equal(
      (await db.outboxEvent.findUniqueOrThrow({ where: { id: expired } })).status,
      'PUBLISHED',
    );
  });

  const insertRow = async (eventType: string, status = 'PENDING', attempts = 0) => {
    const id = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "report"."OutboxEvent" (id, "eventType", "aggregateType", "aggregateId", payload, "correlationId", status, attempts)
       VALUES ($1::uuid, $2, 'test', $1::uuid, '{}'::jsonb, 'x', $3::"report"."OutboxStatus", $4)`,
      id,
      eventType,
      status,
      attempts,
    );
    return id;
  };

  it('dòng PENDING chưa tới nextAttemptAt không bị nhận; tới hạn thì được nhận', async () => {
    const rabbit = await connect();
    const seen: string[] = [];
    await startConsumer(async ({ message }) => void seen.push(message), rabbit);
    const waiting = await addEvent('chua-toi-han');
    const due = await addEvent('da-toi-han');
    const setNext = (id: string, offset: string) =>
      db.$executeRawUnsafe(
        `UPDATE "report"."OutboxEvent" SET "nextAttemptAt" = now() + interval '${offset}' WHERE id = $1::uuid`,
        id,
      );
    await setNext(waiting, '1 hour');
    await setNext(due, '-1 second');

    await newWorker(rabbit).tick();

    await waitFor(() => seen.length === 1, 5_000, 'nhận thư');
    assert.deepEqual(seen, ['da-toi-han']);
    const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: waiting } });
    assert.equal(row.status, 'PENDING');
  });

  it('thư không có binding: các lần thử cách nhau tăng dần, đủ 10 lần thì FAILED', async () => {
    const rabbit = await connect();
    const id = await insertRow('khong.co.binding');
    const unitMs = 5;
    const sentAt: number[] = [];
    const worker = newWorker(
      {
        get isConnected() {
          return rabbit.isConnected;
        },
        publish: async (request) => {
          sentAt.push(Date.now());
          await rabbit.publish(request);
        },
      },
      { backoffUnitMs: unitMs },
    );

    await worker.tick();
    const first = await db.outboxEvent.findUniqueOrThrow({ where: { id } });
    assert.deepEqual([first.status, first.attempts], ['PENDING', 1]);
    assert.ok(first.nextAttemptAt, 'phải có nextAttemptAt');

    // Gọi tick liên tục: khoảng cách giữa các lần gửi chỉ do nextAttemptAt quyết định.
    while ((await db.outboxEvent.findUniqueOrThrow({ where: { id } })).status !== 'FAILED') {
      await worker.tick();
    }

    const last = await db.outboxEvent.findUniqueOrThrow({ where: { id } });
    assert.deepEqual([last.status, last.attempts, last.nextAttemptAt], ['FAILED', 10, null]);
    assert.equal(sentAt.length, 10);
    sentAt.slice(1).forEach((time, index) => {
      const gap = time - (sentAt[index] ?? 0);
      const expected = 2 ** (index + 1) * unitMs;
      assert.ok(
        gap >= expected,
        `lần ${index + 2} cách lần trước ${gap} ms, cần >= ${expected} ms`,
      );
    });
    await worker.tick();
    assert.equal(sentAt.length, 10);
  });

  it('requeue: FAILED về PENDING và được gửi khi đã có binding; --dry-run không đổi gì', async () => {
    const rabbit = await connect();
    const id = await insertRow(TEST_ROUTING_KEY, 'FAILED', 10);
    const other = await insertRow('khong.co.binding', 'FAILED', 10);
    const statusOf = async (rowId: string) => {
      const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: rowId } });
      return [row.status, row.attempts, row.nextAttemptAt];
    };

    const dryRun = outboxRequeue('--id', id, '--dry-run');
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /\[dry-run\] report: sẽ đổi 1 dòng/);
    assert.deepEqual(await statusOf(id), ['FAILED', 10, null]);

    await addTestBinding();
    try {
      const run = outboxRequeue('--id', id);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /report: đã đổi 1 dòng/);
      assert.deepEqual(await statusOf(id), ['PENDING', 0, null]);
      assert.deepEqual(await statusOf(other), ['FAILED', 10, null]);

      await newWorker(rabbit).tick();

      const sent = await db.outboxEvent.findUniqueOrThrow({ where: { id } });
      assert.equal(sent.status, 'PUBLISHED');
      await waitFor(
        async () => (await peekQueue(QUEUE)).some((m) => m.properties.message_id === id),
        5_000,
        'thư tới queue',
      );
    } finally {
      await removeTestBinding();
    }

    assert.match(outboxRequeue('--id', id).stdout, /report: đã đổi 0 dòng/);
  });

  it('requeue từ chối id sai dạng và tham số lạ', () => {
    const wrongId = outboxRequeue('--id', 'khong-phai-uuid');
    assert.equal(wrongId.status, 1);
    assert.match(wrongId.stderr, /UUID/);
    assert.equal(outboxRequeue('--xoa-het').status, 1);
  });

  it('job dọn: chỉ xoá dòng PUBLISHED cũ hơn 7 ngày', async () => {
    const rabbit = await connect();
    const oldPublished = await addEvent();
    const recentPublished = await addEvent();
    const oldPending = await addEvent();
    await db.$executeRawUnsafe(
      `UPDATE "report"."OutboxEvent" SET status = 'PUBLISHED', "publishedAt" = now() - interval '8 days' WHERE id = $1::uuid`,
      oldPublished,
    );
    await db.$executeRawUnsafe(
      `UPDATE "report"."OutboxEvent" SET status = 'PUBLISHED', "publishedAt" = now() - interval '6 days' WHERE id = $1::uuid`,
      recentPublished,
    );
    await db.$executeRawUnsafe(
      `UPDATE "report"."OutboxEvent" SET "createdAt" = now() - interval '30 days' WHERE id = $1::uuid`,
      oldPending,
    );

    assert.equal(await newWorker(rabbit).cleanup(), 1);
    const left = (await db.outboxEvent.findMany(TEST_ROWS)).map((row) => row.id).sort();
    assert.deepEqual(left, [recentPublished, oldPending].sort());
  });

  it('tắt RabbitMQ 30 giây trong lúc ghi 20 sự kiện: cả 20 tới đích, không trùng', async () => {
    const rabbit = await connect();
    const seen = new Map<string, number>();
    await startConsumer(async ({ message }) => {
      seen.set(message, (seen.get(message) ?? 0) + 1);
    }, rabbit);
    startWorker(rabbit);

    for (let index = 0; index < 5; index += 1) {
      await addEvent(`e${index}`);
    }
    await waitFor(() => seen.size === 5, 10_000, '5 thư đầu');

    await compose('stop', 'rabbitmq');
    const stoppedAt = Date.now();
    try {
      await waitFor(() => !rabbit.isConnected, 10_000, 'phát hiện mất kết nối');
      for (let index = 5; index < 20; index += 1) {
        await addEvent(`e${index}`);
        await sleep(1_500);
      }
      await sleep(Math.max(0, 30_000 - (Date.now() - stoppedAt)));
      // Worker không được đốt `attempts` trong lúc mất kết nối.
      const rows = await db.outboxEvent.findMany(TEST_ROWS);
      assert.equal(rows.filter((row) => row.status === 'FAILED').length, 0);
      assert.equal(Math.max(...rows.map((row) => row.attempts)), 0);
    } finally {
      await compose('start', 'rabbitmq');
    }

    await waitFor(() => seen.size === 20, 120_000, 'đủ 20 thư sau khi bật lại');
    await sleep(1_000);
    assert.deepEqual(
      [...seen.values()].filter((count) => count !== 1),
      [],
    );
    assert.equal(await db.processedEvent.count(TEST_PROCESSED), 20);
    assert.deepEqual(await peekQueue(DLQ), []);
    assert.equal(
      await db.outboxEvent.count({
        where: { aggregateType: TEST_AGGREGATE, status: { not: 'PUBLISHED' } },
      }),
      0,
    );
  });

  describe('bản build thật của service', () => {
    let inventory: RunningService;
    let report: RunningService;

    before(async () => {
      inventory = await startService('inventory');
      report = await startService('report');
    });

    after(async () => {
      const stopped = [inventory, report].map(
        (service) =>
          new Promise((done) => {
            service?.child.once('close', done);
            service?.child.kill();
          }),
      );
      await Promise.all(stopped);
    });

    it('log của bên gửi (inventory) và bên nhận (report) có cùng correlationId', async () => {
      const correlationId = randomUUID();
      const eventId = await runWithCorrelationId(correlationId, () =>
        inventoryDb.$transaction((tx: never) =>
          outbox.add(tx as OutboxTx, {
            eventType: ROUTING_KEYS.SYSTEM_TEST,
            aggregateType: TEST_AGGREGATE,
            aggregateId: randomUUID(),
            payload: { message: 'xuyen-service' },
          }),
        ),
      );

      reportProcessed.push(eventId);

      const lines = (service: RunningService) =>
        service.logs.filter((line) => line.correlationId === correlationId);
      await waitFor(
        () => lines(inventory).length > 0 && lines(report).length >= 2,
        10_000,
        'log hai bên',
      );

      assert.ok(
        lines(inventory).some((line) =>
          line.msg?.includes(`Đã gửi sự kiện system.test ${eventId}`),
        ),
      );
      assert.ok(
        lines(report).some((line) => line.msg?.includes('Nhận system.test: xuyen-service')),
      );
      assert.ok(
        lines(report).some((line) => line.msg?.includes(`Đã xử lý sự kiện system.test ${eventId}`)),
      );
      assert.ok(lines(inventory).every((line) => line.service === 'inventory'));
      assert.ok(lines(report).every((line) => line.service === 'report'));
    });

    it('dừng RabbitMQ: /health/ready trả 503; bật lại: tự về 200', async () => {
      const ready = () => fetch(`http://127.0.0.1:${report.port}/health/ready`);
      assert.equal((await ready()).status, 200);

      await compose('stop', 'rabbitmq');
      try {
        await waitFor(async () => (await ready()).status === 503, 20_000, '503');
        const body = await (await ready()).json();
        assert.deepEqual(body, { status: 'error', checks: { postgres: 'up', rabbitmq: 'down' } });
      } finally {
        await compose('start', 'rabbitmq');
      }

      await waitFor(async () => (await ready()).status === 200, 90_000, 'tự về 200');
      assert.deepEqual(await (await ready()).json(), {
        status: 'ok',
        checks: { postgres: 'up', rabbitmq: 'up' },
      });
    });
  });
});
