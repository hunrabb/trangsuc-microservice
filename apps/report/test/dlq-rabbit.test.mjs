import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
const { connect } = require('amqplib');
const { RabbitConnection } = require('@jewelry/common');
const { DlqObserver } = require('../dist/dlq/dlq-observer.js');

process.loadEnvFile('.env');

async function waitFor(check, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Hết thời gian chờ kiểm thử RabbitMQ');
}

test('DLX giữ thư gốc và observer lưu bản sao trước khi ack', async () => {
  const url = process.env.RABBITMQ_URL;
  assert.ok(url, 'Thiếu RABBITMQ_URL trong apps/report/.env');
  const direct = await connect(url);
  const inspection = await direct.createChannel();
  const sourceQueue = 'report.events.dlq';
  const observerQueue = 'report.dlq.observer';
  const originalBefore = await inspection.checkQueue(sourceQueue);
  const observerBefore = await inspection.checkQueue(observerQueue);
  assert.equal(
    originalBefore.messageCount,
    0,
    'DLQ gốc phải trống để không đụng thư của người khác',
  );
  assert.equal(observerBefore.messageCount, 0, 'Queue observer phải trống trước ca kiểm thử');

  const saved = [];
  const db = {
    deadLetterRecord: { createMany: async ({ data }) => saved.push(data[0]) },
    dlqReplayAttempt: { updateMany: async () => ({ count: 0 }) },
  };
  db.$transaction = async (work) => work(db);
  const rabbit = new RabbitConnection(url);
  const observer = new DlqObserver(rabbit, db);
  const marker = randomUUID();
  let published = false;

  try {
    await observer.onApplicationBootstrap();
    await rabbit.start();
    await waitFor(() => rabbit.isConnected);
    const content = Buffer.from(
      JSON.stringify({
        eventId: marker,
        eventType: 'system.test',
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        payload: { message: 'dlq-integration-test' },
      }),
    );
    await rabbit.publish({
      exchange: 'dlx',
      routingKey: sourceQueue,
      content,
      messageId: marker,
      headers: {
        'x-dlq-copy-id': randomUUID(),
        'x-error-kind': 'PERMANENT',
        'x-error-reason': 'integration test',
        'x-original-routing-key': 'system.test',
      },
    });
    published = true;
    await waitFor(() => saved.length === 1);
    assert.equal(saved[0].eventId, marker);
    assert.equal((await inspection.checkQueue(sourceQueue)).messageCount, 1);
  } finally {
    await observer.onModuleDestroy();
    await rabbit.stop();
    if (published) {
      // Chỉ ack thư do chính ca test tạo; không purge hoặc xoá queue.
      await new Promise((resolve, reject) => {
        let tag;
        inspection
          .consume(
            sourceQueue,
            (message) => {
              if (!message) return;
              if (message.properties.messageId !== marker) {
                inspection.nack(message, false, true);
                reject(new Error('Gặp thư khác trong DLQ, không chạm vào'));
                return;
              }
              inspection.ack(message);
              if (tag) void inspection.cancel(tag);
              resolve();
            },
            { noAck: false },
          )
          .then((value) => {
            tag = value.consumerTag;
          })
          .catch(reject);
      });
    }
    await inspection.close();
    await direct.close();
  }
});
