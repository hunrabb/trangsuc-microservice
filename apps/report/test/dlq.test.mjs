import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
const { DlqService } = require('../dist/dlq/dlq.service.js');
const { DlqController } = require('../dist/dlq/dlq.controller.js');
const { DlqObserver } = require('../dist/dlq/dlq-observer.js');
const { replayEnvelope, safeFailureReason } = require('../dist/dlq/dlq-policy.js');

const envelope = () => ({
  eventId: randomUUID(),
  eventType: 'system.test',
  occurredAt: new Date().toISOString(),
  correlationId: randomUUID(),
  payload: { message: 'safe' },
});

function database(row) {
  const attempts = [];
  const db = {
    deadLetterRecord: {
      count: async () => 1,
      findMany: async () => [{ ...row, attempts }],
      findUnique: async () => row,
      updateMany: async ({ where, data }) => {
        if (row.replayCount >= where.replayCount.lt || row.replayLeaseUntil) return { count: 0 };
        row.replayCount += data.replayCount.increment;
        row.replayLeaseUntil = data.replayLeaseUntil;
        return { count: 1 };
      },
      update: async ({ data }) => {
        row.replayLeaseUntil = data.replayLeaseUntil;
      },
    },
    dlqReplayAttempt: {
      create: async ({ data }) => {
        attempts.push({ ...data, status: 'REQUESTED' });
      },
      updateMany: async ({ where, data }) => {
        const attempt = attempts.find((value) => value.id === where.id);
        if (attempt && attempt.status === where.status) Object.assign(attempt, data);
      },
      findUnique: async ({ where }) => attempts.find((value) => value.id === where.id),
    },
  };
  db.$transaction = async (work) => (Array.isArray(work) ? Promise.all(work) : work(db));
  return { db, attempts };
}

function record(sourceQueue = 'report.events') {
  const event = envelope();
  return {
    id: randomUUID(),
    sourceQueue,
    sourceService: sourceQueue.split('.')[0],
    routingKey: 'system.test',
    eventType: event.eventType,
    eventId: event.eventId,
    correlationId: event.correlationId,
    failureKind: 'PERMANENT',
    failureReason: 'Lỗi xử lý sự kiện',
    retryCount: 0,
    content: Uint8Array.from(Buffer.from(JSON.stringify({ ...event, secret: 'private-data' }))),
    failedAt: new Date(),
    replayCount: 0,
    replayLeaseUntil: null,
  };
}

test('API chỉ ADMIN và danh sách không chứa payload hoặc header nhạy cảm', async () => {
  assert.deepEqual(Reflect.getMetadata('jewelry:roles', DlqController), ['ADMIN']);
  const { db } = database(record());
  const service = new DlqService(db, { publish: async () => undefined });
  const page = await service.list({ page: '1', pageSize: '20' });
  assert.equal(page.items.length, 1);
  assert.equal(JSON.stringify(page).includes('private-data'), false);
  assert.equal('content' in page.items[0], false);
  await assert.rejects(() => service.list({ pageSize: '1000' }));
});

test('replay cố định destination, giữ eventId và audit REPUBLISHED sau confirm', async () => {
  const row = record();
  const { db, attempts } = database(row);
  const published = [];
  const service = new DlqService(db, {
    publish: async (request) => {
      published.push(request);
    },
  });
  const result = await service.replay(row.id, randomUUID());
  assert.equal(result.status, 'REPUBLISHED');
  assert.equal(published[0].exchange, 'domain.events');
  assert.equal(published[0].routingKey, 'system.test');
  assert.equal(JSON.parse(published[0].content.toString()).eventId, row.eventId);
  assert.equal(attempts[0].status, 'REPUBLISHED');
  assert.equal(row.content.length > 0, true);
  assert.equal(row.replayLeaseUntil, null);
});

test('publisher lỗi vẫn giữ bản gốc và ghi PUBLISH_UNCONFIRMED', async () => {
  const row = record();
  const original = Buffer.from(row.content);
  const { db, attempts } = database(row);
  const service = new DlqService(db, {
    publish: async () => {
      throw new Error('timeout');
    },
  });
  await assert.rejects(() => service.replay(row.id, randomUUID()));
  assert.equal(attempts[0].status, 'PUBLISH_UNCONFIRMED');
  assert.deepEqual(Buffer.from(row.content), original);
  assert.equal(row.replayLeaseUntil, null);
});

test('queue không có handler hoặc payload sai không được replay', async () => {
  const row = record('sales.events');
  const { db } = database(row);
  const service = new DlqService(db, { publish: async () => assert.fail('must not publish') });
  await assert.rejects(() => service.replay(row.id, randomUUID()));
  assert.equal(
    replayEnvelope(Buffer.from(JSON.stringify({ ...envelope(), payload: {} })), 'report.events'),
    null,
  );
});

test('exception chứa bí mật chỉ hiển thị nhóm lỗi', () => {
  const reason = safeFailureReason({
    'x-error-reason': 'DATABASE_URL=secret',
    'x-error-kind': 'PERMANENT',
  });
  assert.equal(reason.includes('secret'), false);
});

test('observer lưu một bản sao và không đưa raw exception vào metadata', async () => {
  const event = envelope();
  const content = Buffer.from(JSON.stringify({ ...event, password: 'private-data' }));
  const stored = [];
  const db = {
    deadLetterRecord: {
      createMany: async ({ data }) => {
        if (!stored.some((row) => row.id === data[0].id)) stored.push(data[0]);
      },
    },
    dlqReplayAttempt: { updateMany: async () => ({ count: 0 }) },
  };
  db.$transaction = async (work) => work(db);
  const observer = new DlqObserver({ addSetup: async () => undefined }, db);
  const message = {
    fields: { routingKey: 'report.events.dlq' },
    content,
    properties: {
      messageId: event.eventId,
      headers: {
        'x-error-kind': 'PERMANENT',
        'x-error-reason': 'password=private-data',
        'x-retry-count': 2,
        'x-original-routing-key': 'system.test',
      },
    },
  };
  await observer.record(message);
  await observer.record(message);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].sourceService, 'report');
  assert.equal(stored[0].routingKey, 'system.test');
  assert.equal(stored[0].retryCount, 2);
  assert.equal(stored[0].failureReason.includes('private-data'), false);
  assert.equal(Buffer.from(stored[0].content).equals(content), true);
});
