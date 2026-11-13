// Run a locally compiled service only against the labelled acceptance stack.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertTestTarget } from './assert-test-target.mjs';

const service = process.argv[2];
assert.ok(service === 'sales' || service === 'report', 'Expected sales or report');
const root = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(root, '.env'));
for (const [name, port] of [['auth', 15433], ['inventory', 15434], ['sales', 15435], ['report', 15436]]) {
  assertTestTarget(name, port);
}
const broker = spawnSync('docker', ['inspect', 'jewelry-db-separation-test-rabbitmq-1'], { encoding: 'utf8' });
assert.equal(broker.status, 0, 'test RabbitMQ missing');
const [container] = JSON.parse(broker.stdout);
assert.equal(container.Config.Labels['com.docker.compose.project'], 'jewelry-db-separation-test');
assert.equal(container.State.Running, true);
assert.ok((container.NetworkSettings.Ports['5672/tcp'] ?? []).some((binding) => binding.HostIp === '127.0.0.1' && binding.HostPort === '15677'));
const dbPort = service === 'sales' ? 15435 : 15436;
const appPort = service === 'sales' ? 13003 : 13004;
const dbUrl = new URL(`postgresql://${service}_user@127.0.0.1:${dbPort}/${service}_db`);
dbUrl.password = process.env[`${service.toUpperCase()}_DB_PASSWORD`];
dbUrl.searchParams.set('schema', service);
const rabbitUrl = new URL('amqp://127.0.0.1:15677');
rabbitUrl.username = process.env.RABBITMQ_APP_USER;
rabbitUrl.password = process.env.RABBITMQ_APP_PASSWORD;
Object.assign(process.env, {
  NODE_ENV: 'production',
  PORT: String(appPort),
  DATABASE_URL: dbUrl.href,
  DATABASE_POOL_MAX: '15',
  RABBITMQ_URL: rabbitUrl.href,
  JWT_PUBLIC_KEY_PATH: resolve(root, 'secrets/jwt/public.pem'),
  ...(service === 'sales' ? { INVENTORY_URL: 'http://127.0.0.1:13002' } : {}),
});
console.log(`Starting ${service} against verified test DB and RabbitMQ on port ${appPort}`);
await import(resolve(root, `apps/${service}/dist/main.js`));
