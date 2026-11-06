// gateway, inventory, sales đều là bản build thật. Mọi kết luận "service không nhận request" dựa trên log của service.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createTestKeys,
  signHs256WithPublicKey,
  signNoneToken,
  signTestToken,
} from '@jewelry/test-utils';
import {
  freePort,
  type LogLine,
  type RunningService,
  startService,
  testKeys,
  waitForLogs,
  waitUntilLive,
} from './support.ts';

type LoggedRequest = LogLine & { req?: { url?: string } };

const token = (claims = {}) => signTestToken(testKeys.privateKey, { kid: testKeys.kid, claims });
const NO_REQUEST_GRACE_MS = 300;

describe('gateway kiểm tra token trước khi chuyển tiếp', () => {
  let gateway: RunningService;
  let inventory: RunningService;
  let sales: RunningService;
  let gatewayUrl: string;

  before(async () => {
    const [gatewayPort, inventoryPort, salesPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
    ]);
    gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    inventory = startService('inventory', {
      PORT: String(inventoryPort),
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test?schema=inventory',
    });
    sales = startService('sales', {
      PORT: String(salesPort),
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test?schema=sales',
    });
    gateway = startService('gateway', {
      PORT: String(gatewayPort),
      AUTH_URL: 'http://127.0.0.1:1',
      INVENTORY_URL: `http://127.0.0.1:${inventoryPort}`,
      SALES_URL: `http://127.0.0.1:${salesPort}`,
      REPORT_URL: 'http://127.0.0.1:1',
    });
    await Promise.all([inventoryPort, salesPort, gatewayPort].map(waitUntilLive));
  });

  after(() => {
    for (const service of [gateway, inventory, sales]) {
      service?.child.kill();
    }
  });

  const call = (path: string, id: string, authorization?: string) =>
    fetch(`${gatewayUrl}${path}`, {
      headers: { 'x-correlation-id': id, ...(authorization ? { authorization } : {}) },
    });

  const expectRejected = async (
    authorization: string | undefined,
    status: number,
    code: string,
  ) => {
    const id = randomUUID();
    const response = await call('/api/admin/inventory/thu', id, authorization);
    assert.equal(response.status, status);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, code);
    assert.equal(body.correlationId, id);

    // Có log ở gateway rồi mới kết luận inventory không nhận: chờ thêm một nhịp cho chắc.
    assert.ok((await waitForLogs(gateway, id)).length > 0);
    await new Promise((done) => setTimeout(done, NO_REQUEST_GRACE_MS));
    assert.equal(inventory.logs.filter((line) => line.correlationId === id).length, 0);
  };

  it('không token: 401 ở gateway, inventory không nhận request', async () => {
    await expectRejected(undefined, 401, 'INVALID_TOKEN');
  });

  it('token hợp lệ: tới inventory, đường đã viết lại', async () => {
    const id = randomUUID();
    const response = await call('/api/admin/inventory/thu', id, `Bearer ${await token()}`);

    assert.equal(response.status, 404);
    const logged = (await waitForLogs(inventory, id)) as LoggedRequest[];
    assert.ok(logged.some((line) => line.req?.url === '/admin/thu'));
  });

  it('token hết hạn: 401 TOKEN_EXPIRED, không chuyển tiếp', async () => {
    const exp = Math.floor(Date.now() / 1000) - 3600;
    await expectRejected(`Bearer ${await token({ exp })}`, 401, 'TOKEN_EXPIRED');
  });

  it('alg: none, HS256 ký bằng public key, khoá lạ: 401, không chuyển tiếp', async () => {
    const stranger = createTestKeys();
    const forged = [
      signNoneToken(testKeys.kid),
      signHs256WithPublicKey(testKeys.publicPem, testKeys.kid),
      await signTestToken(stranger.privateKey, { kid: testKeys.kid }),
      await signTestToken(testKeys.privateKey, { kid: 'la' }),
    ];
    for (const value of forged) {
      await expectRejected(`Bearer ${value}`, 401, 'INVALID_TOKEN');
    }
  });

  it('/api/admin/inventory/health/ready: 404, kể cả có token, không tới inventory', async () => {
    for (const authorization of [undefined, `Bearer ${await token()}`]) {
      const id = randomUUID();
      const response = await call('/api/admin/inventory/health/ready', id, authorization);
      assert.equal(response.status, 404);
      assert.equal(((await response.json()) as { code: string }).code, 'NOT_FOUND');
      await new Promise((done) => setTimeout(done, NO_REQUEST_GRACE_MS));
      assert.equal(inventory.logs.filter((line) => line.correlationId === id).length, 0);
    }
  });

  it('/api/admin/sales/pos/x tới sales ở /admin/pos/x, không phải /pos/x', async () => {
    const id = randomUUID();
    await call('/api/admin/sales/pos/x', id, `Bearer ${await token()}`);
    const logged = (await waitForLogs(sales, id)) as LoggedRequest[];
    assert.ok(logged.some((line) => line.req?.url === '/admin/pos/x'));
    assert.ok(!logged.some((line) => line.req?.url === '/pos/x'));
  });

  it('đường không có trong bảng: 404 dù không có token', async () => {
    const response = await call('/api/khong-co', randomUUID());
    assert.equal(response.status, 404);
  });

  it('đường công khai đi qua không cần token: /api/shop tới sales', async () => {
    const id = randomUUID();
    await call('/api/shop/thu', id);
    const logged = (await waitForLogs(sales, id)) as LoggedRequest[];
    assert.ok(logged.some((line) => line.req?.url === '/shop/thu'));
  });

  it('/api/ping và /health/live không cần token', async () => {
    assert.equal((await call('/api/ping', randomUUID())).status, 200);
    assert.equal((await call('/health/live', randomUUID())).status, 200);
  });
});
