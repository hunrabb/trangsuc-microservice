import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import {
  EVENT_PAYLOAD_SCHEMAS,
  eventEnvelopeSchema,
  QUEUES,
  RETRY_TIERS,
  retryQueueName,
  ROUTING_KEYS,
} from '@jewelry/contracts';
import { Logger } from '@nestjs/common';
import { runWithCorrelationId } from '../correlation/correlation-id.ts';
import { outbox, type OutboxTx } from './outbox.ts';
import { consumerPoolProblem } from './consumer.ts';
import { countFailedEvents, parseRequeueArgs, requeueFailedEvents } from './outbox-requeue.ts';
import { type OutboxDb, outboxBackoffMs, OutboxWorker } from './outbox-worker.ts';
import {
  rabbitCheck,
  RabbitUnavailableError,
  UnroutableMessageError,
} from './rabbit-connection.ts';

const fakeTx = () => {
  const created: Record<string, unknown>[] = [];
  const tx = {
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => created.push(data),
    },
  } as unknown as OutboxTx;
  return { tx, created };
};

const input = {
  eventType: ROUTING_KEYS.SYSTEM_TEST,
  aggregateType: 'test',
  aggregateId: randomUUID(),
  payload: { message: 'xin chào' },
};

describe('outbox.add', () => {
  it('ghi trong tx được truyền vào, kèm correlationId hiện tại, trả eventId', async () => {
    const { tx, created } = fakeTx();
    const id = await runWithCorrelationId('ma-tuong-quan', () => outbox.add(tx, input));
    assert.equal(created.length, 1);
    assert.equal(created[0]?.id, id);
    assert.equal(created[0]?.correlationId, 'ma-tuong-quan');
    assert.equal(created[0]?.eventType, 'system.test');
  });

  it('payload sai schema: ném lỗi, không ghi', async () => {
    const { tx, created } = fakeTx();
    await assert.rejects(outbox.add(tx, { ...input, payload: { message: 1 as never } }));
    assert.equal(created.length, 0);
  });

  it('sự kiện chưa khai báo: ném lỗi, không ghi', async () => {
    const { tx, created } = fakeTx();
    await assert.rejects(outbox.add(tx, { ...input, eventType: 'khong.co' } as never));
    assert.equal(created.length, 0);
  });
});

describe('OutboxWorker khi mất RabbitMQ', () => {
  const row = (id: string) => ({
    id,
    eventType: 'system.test',
    payload: {},
    correlationId: 'c',
    createdAt: new Date(),
    attempts: 0,
  });

  const fakeDb = (rows: ReturnType<typeof row>[]) => {
    const statements: { sql: string; values: unknown[] }[] = [];
    const db = {
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
        statements.push({ sql, values });
        return sql.includes('RETURNING id') ? rows : [{ status: 'PENDING', attempts: 1 }];
      },
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
        statements.push({ sql, values });
        return 1;
      },
    } as unknown as OutboxDb;
    return { db, statements };
  };

  before(() => Logger.overrideLogger(false));

  it('đang mất kết nối: không nhận lô, không đụng tới bảng', async () => {
    const { db, statements } = fakeDb([row('a')]);
    const worker = new OutboxWorker({
      db,
      dbSchema: 'report',
      rabbit: { isConnected: false, publish: async () => undefined },
    });
    await worker.cleanup();
    statements.length = 0;
    await worker.tick();
    assert.equal(statements.filter((s) => s.sql.includes('PROCESSING')).length, 0);
  });

  it('đứt giữa lô: dòng đã gửi giữ nguyên, phần còn lại về PENDING, không tăng attempts', async () => {
    const { db, statements } = fakeDb([row('a'), row('b'), row('c')]);
    let sent = 0;
    const worker = new OutboxWorker({
      db,
      dbSchema: 'report',
      rabbit: {
        isConnected: true,
        publish: async () => {
          sent += 1;
          if (sent === 2) {
            throw new RabbitUnavailableError('đứt');
          }
        },
      },
    });
    await worker.tick();
    const release = statements.find((s) => s.sql.includes('ANY($1::uuid[])'));
    assert.deepEqual(release?.values[0], ['b', 'c']);
    assert.equal(statements.filter((s) => s.sql.includes('attempts + 1')).length, 0);
  });

  it('gần hết thời gian giữ dòng: dừng gửi, phần còn lại về PENDING, không tăng attempts', async () => {
    const { db, statements } = fakeDb([row('a'), row('b'), row('c')]);
    const sent: string[] = [];
    const worker = new OutboxWorker({
      db,
      dbSchema: 'report',
      sendWindowMs: 30,
      rabbit: {
        isConnected: true,
        publish: async ({ messageId }) => {
          sent.push(messageId);
          await new Promise((done) => setTimeout(done, 50));
        },
      },
    });
    await worker.tick();
    assert.deepEqual(sent, ['a']);
    const release = statements.find((s) => s.sql.includes('ANY($1::uuid[])'));
    assert.deepEqual(release?.values[0], ['b', 'c']);
    assert.equal(statements.filter((s) => s.sql.includes('attempts + 1')).length, 0);
  });

  it('gửi lỗi: nghỉ theo số lần đã lỗi, truyền đúng thời gian vào SQL', async () => {
    const { db, statements } = fakeDb([{ ...row('a'), attempts: 3 }]);
    const worker = new OutboxWorker({
      db,
      dbSchema: 'report',
      rabbit: {
        isConnected: true,
        publish: async () => {
          throw new UnroutableMessageError('không queue nào nhận');
        },
      },
    });
    await worker.tick();
    const failure = statements.find((s) => s.sql.includes('attempts + 1'));
    assert.deepEqual(failure?.values, ['a', 10, 16_000]);
  });

  it('chỉ nhận dòng PENDING đã tới hạn', async () => {
    const { db, statements } = fakeDb([]);
    const rabbit = { isConnected: true, publish: async () => undefined };
    await new OutboxWorker({ db, rabbit, dbSchema: 'report' }).tick();
    const claim = statements.find((s) => s.sql.includes('SKIP LOCKED'));
    assert.match(claim?.sql ?? '', /"nextAttemptAt" IS NULL OR "nextAttemptAt" <= now\(\)/);
  });

  it('tên schema lạ bị từ chối vì đi thẳng vào SQL', () => {
    const { db } = fakeDb([]);
    const rabbit = { isConnected: true, publish: async () => undefined };
    assert.throws(() => new OutboxWorker({ db, rabbit, dbSchema: 'x"; DROP' }));
  });
});

describe('outboxBackoffMs', () => {
  it('2^attempts giây, tối đa 5 phút', () => {
    assert.deepEqual(
      [1, 2, 3, 8, 9, 10, 40].map((attempts) => outboxBackoffMs(attempts)),
      [2_000, 4_000, 8_000, 256_000, 300_000, 300_000, 300_000],
    );
  });

  it('rút được đơn vị trong test, trần vẫn là 5 phút', () => {
    assert.equal(outboxBackoffMs(3, 10), 80);
    assert.equal(outboxBackoffMs(30, 10), 300_000);
  });
});

describe('kiểm tra pool lúc khởi động', () => {
  it('đủ prefetch 10 + 5 thì qua', () => {
    assert.equal(consumerPoolProblem(15), undefined);
    assert.equal(consumerPoolProblem(20), undefined);
  });

  it('thiếu thì báo rõ lý do', () => {
    assert.match(consumerPoolProblem(14) ?? '', /DATABASE_POOL_MAX = 14 quá nhỏ.*tối thiểu 15/);
  });
});

describe('parseRequeueArgs', () => {
  const id = randomUUID();

  it('đọc đủ tham số, bỏ qua `--` của pnpm', () => {
    assert.deepEqual(
      parseRequeueArgs([
        '--',
        '--service',
        'report',
        '--event-type',
        'system.test',
        '--id',
        id,
        '--dry-run',
      ]),
      { service: 'report', eventType: 'system.test', id, dryRun: true },
    );
  });

  it('bắt buộc --service', () => {
    assert.throws(() => parseRequeueArgs(['--dry-run']), /Thiếu --service/);
  });

  it('từ chối id sai dạng và tham số lạ', () => {
    assert.throws(() => parseRequeueArgs(['--service', 'report', '--id', 'x']), /UUID/);
    assert.throws(() => parseRequeueArgs(['--service', 'report', '--xoa-het']));
  });
});

describe('requeue', () => {
  const recorder = () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const db = {
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
        calls.push({ sql, values });
        return [{ count: 3n }];
      },
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
        calls.push({ sql, values });
        return 3;
      },
    } as unknown as OutboxDb;
    return { db, calls };
  };

  it('chỉ đổi dòng FAILED, đặt lại attempts và nextAttemptAt', async () => {
    const { db, calls } = recorder();
    assert.equal(await requeueFailedEvents(db, 'report', { eventType: 'x' }), 3);
    const { sql, values } = calls[0]!;
    assert.match(sql, /status = 'PENDING', attempts = 0, "nextAttemptAt" = NULL/);
    assert.match(sql, /WHERE status = 'FAILED'/);
    assert.deepEqual(values, ['x', null]);
  });

  it('đếm cho --dry-run chỉ là SELECT', async () => {
    const { db, calls } = recorder();
    assert.equal(await countFailedEvents(db, 'report', {}), 3);
    assert.match(calls[0]!.sql, /^SELECT count/);
    assert.doesNotMatch(calls[0]!.sql, /UPDATE|DELETE/);
  });
});

describe('rabbitCheck', () => {
  it('chưa kết nối thì báo lỗi', async () => {
    await assert.rejects(rabbitCheck({ isConnected: false }).check());
    await rabbitCheck({ isConnected: true }).check();
  });
});

describe('definitions.json khớp hợp đồng', () => {
  interface Queue {
    name: string;
    arguments: Record<string, unknown>;
  }
  const definitions = JSON.parse(
    readFileSync(resolve('../../infra/rabbitmq/definitions.json'), 'utf8'),
  ) as {
    queues: Queue[];
    bindings: { source: string; routing_key: string; destination: string }[];
  };

  it('mọi queue chính có đủ queue chờ, TTL đúng, hết hạn thì quay lại queue chính', () => {
    for (const queue of Object.values(QUEUES)) {
      RETRY_TIERS.forEach((tier, index) => {
        const found = definitions.queues.find((q) => q.name === retryQueueName(queue, index));
        assert.ok(found, `thiếu queue chờ ${queue} bậc ${index}`);
        assert.equal(found.arguments['x-message-ttl'], tier.ttlMs);
        assert.equal(found.arguments['x-dead-letter-exchange'], '');
        assert.equal(found.arguments['x-dead-letter-routing-key'], queue);
      });
    }
  });

  it('5 s → 30 s → 5 phút', () => {
    assert.deepEqual(
      RETRY_TIERS.map((tier) => tier.ttlMs),
      [5_000, 30_000, 300_000],
    );
  });

  it('mọi sự kiện đều có queue nhận', () => {
    for (const eventType of Object.keys(EVENT_PAYLOAD_SCHEMAS)) {
      const bound = definitions.bindings.some(
        (b) => b.source === 'domain.events' && b.routing_key === eventType,
      );
      assert.ok(bound, `sự kiện ${eventType} không có binding`);
    }
  });

  it('system.test chỉ vào report.events', () => {
    const bindings = definitions.bindings.filter((b) => b.routing_key === 'system.test');
    assert.deepEqual(
      bindings.map((b) => b.destination),
      ['report.events'],
    );
  });
});

describe('phong bì thư', () => {
  it('chấp nhận thư đúng, từ chối thiếu trường', () => {
    const valid = {
      eventId: randomUUID(),
      eventType: 'system.test',
      occurredAt: new Date().toISOString(),
      correlationId: 'c',
      payload: {},
    };
    assert.equal(eventEnvelopeSchema.safeParse(valid).success, true);
    assert.equal(eventEnvelopeSchema.safeParse({ ...valid, eventId: 'x' }).success, false);
    assert.equal(eventEnvelopeSchema.safeParse({ ...valid, occurredAt: 'hom nay' }).success, false);
  });
});
