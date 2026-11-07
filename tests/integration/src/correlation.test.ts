// Chạy bản build thật của gateway và inventory rồi đọc log trên stdout, không mock gì.
// devDependencies `workspace:*` khiến turbo build hai app này trước. Không cần Postgres:
// /api/ping không chạm DB và Prisma chỉ kết nối khi có truy vấn đầu tiên.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createTestKeyFiles } from '@jewelry/test-utils';
import {
  freePort,
  type RunningService,
  startService,
  waitForLogs,
  waitUntilLive,
} from './support.ts';

const UUID_PATTERN = /^[0-9a-f-]{36}$/;

describe('correlationId đi xuyên gateway → inventory', () => {
  let gateway: RunningService;
  let inventory: RunningService;
  let gatewayPort: number;

  before(async () => {
    gatewayPort = await freePort();
    const inventoryPort = await freePort();
    inventory = startService('inventory', {
      PORT: String(inventoryPort),
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test?schema=inventory',
    });
    gateway = startService('gateway', {
      PORT: String(gatewayPort),
      AUTH_URL: 'http://127.0.0.1:1',
      INVENTORY_URL: `http://127.0.0.1:${inventoryPort}`,
      SALES_URL: 'http://127.0.0.1:1',
      REPORT_URL: 'http://127.0.0.1:1',
    });
    await Promise.all([waitUntilLive(inventoryPort), waitUntilLive(gatewayPort)]);
  });

  after(() => {
    gateway?.child.kill();
    inventory?.child.kill();
  });

  const ping = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${gatewayPort}/api/ping`, { headers });

  it('dùng UUID của client: có trong header phản hồi và log của cả hai service', async () => {
    const id = randomUUID();
    const response = await ping({ 'x-correlation-id': id });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { service: 'inventory', ok: true });
    assert.equal(response.headers.get('x-correlation-id'), id);

    const [gatewayLogs, inventoryLogs] = await Promise.all([
      waitForLogs(gateway, id),
      waitForLogs(inventory, id),
    ]);
    assert.ok(gatewayLogs.some((line) => line.service === 'gateway'));
    assert.ok(inventoryLogs.some((line) => line.service === 'inventory'));
  });

  it('mã không hợp lệ bị thay bằng UUID mới, log hai bên vẫn cùng mã', async () => {
    const response = await ping({ 'x-correlation-id': 'abc' });
    const id = response.headers.get('x-correlation-id') ?? '';

    assert.notEqual(id, 'abc');
    assert.match(id, UUID_PATTERN);
    assert.ok((await waitForLogs(gateway, id)).length > 0);
    assert.ok((await waitForLogs(inventory, id)).length > 0);
  });

  it('không có header: gateway tự sinh mã', async () => {
    const response = await ping({});
    assert.match(response.headers.get('x-correlation-id') ?? '', UUID_PATTERN);
  });

  it('không ghi Authorization và Cookie ra log', async () => {
    const id = randomUUID();
    await ping({ 'x-correlation-id': id, authorization: 'Bearer bi-mat', cookie: 'phien=bi-mat' });
    const lines = await waitForLogs(gateway, id);

    assert.ok(lines.length > 0);
    assert.ok(!JSON.stringify(lines).includes('bi-mat'));
  });
});

describe('kiểm tra cấu hình lúc khởi động', () => {
  it('auth có private key và public key khác cặp: log rõ lý do và thoát mã 1', async () => {
    const other = createTestKeyFiles();
    const service = startService('auth', {
      PORT: String(await freePort()),
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test?schema=auth',
      JWT_PRIVATE_KEY_PATH: other.privateKeyPath,
      GOOGLE_CLIENT_ID: 'test',
    });
    const code = await new Promise((done) => service.child.once('close', done));

    assert.equal(code, 1);
    assert.ok(service.logs.some((line) => /không phải một cặp/.test(line.msg ?? '')));
  });

  const smallPoolEnv = (service: string, port: number) => ({
    PORT: String(port),
    DATABASE_URL: `postgresql://test:test@127.0.0.1:1/test?schema=${service}`,
    DATABASE_POOL_MAX: '14',
  });

  it('service có consumer mà pool nhỏ hơn mức cần: log rõ lý do và thoát mã 1', async () => {
    const service = startService('report', smallPoolEnv('report', await freePort()));
    const code = await new Promise((done) => service.child.once('close', done));

    assert.equal(code, 1);
    const fatal = service.logs.find((line) =>
      /DATABASE_POOL_MAX = 14 quá nhỏ/.test(line.msg ?? ''),
    );
    assert.match(fatal?.msg ?? '', /tối thiểu 15/);
    assert.equal(fatal?.service, 'report');
  });

  it('service chưa có consumer thì không bị ràng buộc pool', async () => {
    const port = await freePort();
    const service = startService('sales', smallPoolEnv('sales', port));
    try {
      await waitUntilLive(port);
    } finally {
      service.child.kill();
    }
  });

  it('thiếu biến thì log rõ tên biến và thoát mã 1', async () => {
    const service = startService('inventory', { PORT: '3999' });
    const code = await new Promise((done) => service.child.once('close', done));

    assert.equal(code, 1);
    assert.match(service.logs[0]?.msg ?? '', /DATABASE_URL \(thiếu biến\)/);
  });
});
