import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
const { PrismaService } = require('../dist/prisma/prisma.service.js');
const { DlqService } = require('../dist/dlq/dlq.service.js');

process.loadEnvFile('.env');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));

test('PostgreSQL: hai ADMIN tranh một thư chỉ một lần publish, audit và bản gốc còn nguyên', async () => {
  const prisma = new PrismaService({
    get: (key) =>
      key === 'DATABASE_POOL_MAX' ? Number(process.env.DATABASE_POOL_MAX) : process.env[key],
  });
  const id = randomUUID();
  const eventId = randomUUID();
  const content = Uint8Array.from(
    Buffer.from(
      JSON.stringify({
        eventId,
        eventType: 'system.test',
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        payload: { message: 'dlq-postgres-test' },
      }),
    ),
  );
  let finishPublish;
  let publishStarted;
  const started = new Promise((resolve) => {
    publishStarted = resolve;
  });
  const service = new DlqService(prisma, {
    publish: async () => {
      publishStarted();
      await new Promise((resolve) => {
        finishPublish = resolve;
      });
    },
  });

  try {
    await prisma.deadLetterRecord.create({
      data: {
        id,
        sourceQueue: 'report.events',
        sourceService: 'report',
        routingKey: 'system.test',
        eventType: 'system.test',
        eventId,
        correlationId: randomUUID(),
        failureKind: 'PERMANENT',
        failureReason: 'Kiểm thử',
        retryCount: 0,
        content,
      },
    });
    const first = service.replay(id, randomUUID());
    await started;
    await assert.rejects(
      () => service.replay(id, randomUUID()),
      (error) => error.code === 'DLQ_REPLAY_BUSY',
    );
    finishPublish();
    const result = await first;
    assert.equal(result.status, 'REPUBLISHED');

    const row = await prisma.deadLetterRecord.findUniqueOrThrow({
      where: { id },
      include: { attempts: true },
    });
    assert.equal(row.replayCount, 1);
    assert.equal(row.attempts.length, 1);
    assert.equal(row.attempts[0].status, 'REPUBLISHED');
    assert.deepEqual(Buffer.from(row.content), Buffer.from(content));
    const page = await service.list({ page: '1', pageSize: '10', service: 'report' });
    assert.equal(JSON.stringify(page).includes('dlq-postgres-test'), false);
  } finally {
    if (finishPublish) finishPublish();
    await prisma.dlqReplayAttempt.deleteMany({ where: { recordId: id } });
    await prisma.deadLetterRecord.deleteMany({ where: { id } });
    await prisma.$disconnect();
  }
});
