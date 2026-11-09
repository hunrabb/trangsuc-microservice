// 6.5B ONLY. Re-publish a selected owned outbox event twice on the isolated broker.
// This proves publisher confirm only; verify ProcessedEvent and business rows separately.
import { createRequire } from 'node:module';
import { requireAcknowledgement, databaseUrl, rabbitUrl } from './test-environment.mjs';
const commonRequire = createRequire(new URL('../../libs/common/package.json', import.meta.url));
const contracts = commonRequire('@jewelry/contracts');
let prisma, connection, channel;
try {
  requireAcknowledgement();
  const service = process.env.PHASE6_TEST_EVENT_SERVICE;
  if (!['inventory', 'sales'].includes(service))
    throw new Error('Choose inventory or sales outbox');
  const eventId = contracts.shopProductSchema.shape.id.parse(process.env.PHASE6_TEST_EVENT_ID);
  const aggregateId = contracts.shopProductSchema.shape.id.parse(
    process.env.PHASE6_TEST_AGGREGATE_ID,
  );
  const dbUrl = databaseUrl(process.env[`PHASE6_TEST_${service.toUpperCase()}_URL`], service);
  const amqpUrl = rabbitUrl(process.env.PHASE6_TEST_RABBITMQ_URL);
  const appRequire = createRequire(new URL(`../../apps/${service}/package.json`, import.meta.url));
  const { PrismaPg } = appRequire('@prisma/adapter-pg');
  const { PrismaClient } = appRequire('./dist/generated/prisma/client.js');
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: dbUrl, max: 1 }, { schema: service }),
  });
  const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (row.aggregateId !== aggregateId) throw new Error('Event does not belong to selected fixture');
  const envelope = contracts.eventEnvelopeSchema.parse({
    eventId: row.id,
    eventType: row.eventType,
    occurredAt: row.createdAt.toISOString(),
    correlationId: row.correlationId,
    payload: row.payload,
  });
  if (!contracts.isEventType(row.eventType)) throw new Error('Unknown event');
  contracts.EVENT_PAYLOAD_SCHEMAS[row.eventType].parse(row.payload);
  connection = await commonRequire('amqplib').connect(amqpUrl);
  channel = await connection.createConfirmChannel();
  let returned = false;
  channel.on('return', () => {
    returned = true;
  });
  for (let n = 0; n < 2; n++)
    await new Promise((resolve, reject) =>
      channel.publish(
        'domain.events',
        row.eventType,
        Buffer.from(JSON.stringify(envelope)),
        {
          persistent: true,
          mandatory: true,
          messageId: row.id,
          contentType: 'application/json',
          headers: { 'x-correlation-id': row.correlationId },
        },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  if (returned) throw new Error('Unroutable event');
  console.log(
    JSON.stringify({
      publication: 'CONFIRMED twice; business deduplication still needs DB assertions',
      eventId,
      aggregateId,
      eventType: row.eventType,
    }),
  );
} catch {
  console.error(
    'FAIL/NOT VERIFIED: isolated redelivery preconditions/publication failed; credentials are not printed.',
  );
  process.exitCode = 1;
} finally {
  if (channel) await channel.close();
  if (connection) await connection.close();
  if (prisma) await prisma.$disconnect();
}
