// Phase 3 only. Runs Node, never the NestJS entrypoint. All credentials from demo Secrets.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const commonPath = require('node:fs').realpathSync('/app/node_modules/@jewelry/common');
const amqp = require(require.resolve('amqplib', { paths: [commonPath] }));
const queue = 'phase3.probe.connectivity';
const url = `${process.env.MANAGEMENT_URL}/api/queues/jewelry-demo/${queue}`;
const authorization = 'Basic ' + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString('base64');
async function api(method, body) {
  const r = await fetch(url, { method, headers: { authorization, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  if (!r.ok && !(method === 'DELETE' && r.status === 404)) throw new Error(`HTTP ${method} status ${r.status}: ${(await r.text()).slice(0, 500)}`);
}
(async () => {
  let conn;
  try {
    await api('PUT', { durable: true, auto_delete: false, arguments: { 'x-queue-type': 'classic' } });
    console.log('PASS isolated test queue provisioned');
    conn = await amqp.connect(process.env.RABBITMQ_URL, { timeout: 10000 });
    console.log('PASS AMQP connected with demo app credential');
    const ch = await conn.createConfirmChannel();
    const payload = `jewelry-demo-phase3-${crypto.randomUUID()}`;
    ch.sendToQueue(queue, Buffer.from(payload), { persistent: false });
    await ch.waitForConfirms();
    const message = await ch.get(queue, { noAck: false });
    assert.ok(message); assert.equal(message.content.toString(), payload); ch.ack(message);
    await ch.close();
    console.log('PASS TCP/AMQP authentication, publisher confirm, consume exact test message');
  } finally {
    if (conn) await conn.close();
    await api('DELETE');
  }
  console.log('PASS test queue deleted');
})().catch(e => {
  let message = String(e.message).replace(/amqps?:\/\/[^\s]+/g, 'amqp://[REDACTED]');
  for (const value of [process.env.ADMIN_PASSWORD, new URL(process.env.RABBITMQ_URL).password]) {
    if (value) message = message.split(value).join('[REDACTED]');
  }
  console.error('Probe failed:', e.code || e.name, message); process.exitCode = 1;
});
