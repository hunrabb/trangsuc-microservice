// sales chạy bản build thật; inventory và auth là máy chủ giả có ghi nhận request, để kiểm tra
// cả những gì KHÔNG được tới nơi. Không cần Postgres.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { signTestToken } from '@jewelry/test-utils';
import {
  freePort,
  type LogLine,
  type RunningService,
  startService,
  testKeys,
  waitForLogs,
  waitUntilLive,
} from './support.ts';

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  sha256: string;
  size: number;
}

const bearer = async () => `Bearer ${await signTestToken(testKeys.privateKey)}`;

type LoggedRequest = LogLine & { req?: { headers?: Record<string, string> } };

describe('gateway chuyển tiếp request', () => {
  let gateway: RunningService;
  let sales: RunningService;
  let fake: Server;
  let gatewayUrl: string;
  let seen: Seen[];
  let reply: (res: ServerResponse) => void;

  before(async () => {
    fake = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const sha256 = createHash('sha256').update(body).digest('hex');
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          sha256,
          size: body.length,
        });
        reply(res);
      });
    });
    await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
    const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    const gatewayPort = await freePort();
    const salesPort = await freePort();
    gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    sales = startService('sales', {
      PORT: String(salesPort),
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test?schema=sales',
    });
    gateway = startService('gateway', {
      PORT: String(gatewayPort),
      AUTH_URL: fakeUrl,
      INVENTORY_URL: fakeUrl,
      SALES_URL: `http://127.0.0.1:${salesPort}`,
      REPORT_URL: 'http://127.0.0.1:1',
    });
    await Promise.all([waitUntilLive(salesPort), waitUntilLive(gatewayPort)]);
  });

  after(() => {
    gateway?.child.kill();
    sales?.child.kill();
    fake?.closeAllConnections();
    fake?.close();
  });

  beforeEach(() => {
    seen = [];
    reply = (res) => void res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });

  const expectErrorBody = async (response: Response, status: number, code: string) => {
    assert.equal(response.status, status);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, code);
    assert.equal(typeof body.message, 'string');
    assert.equal(body.correlationId, response.headers.get('x-correlation-id'));
    assert.ok(!('stack' in body));
    return body;
  };

  it('gateway → sales: 404 NOT_FOUND định dạng chung, correlationId khớp header và body', async () => {
    const id = randomUUID();
    const response = await fetch(`${gatewayUrl}/api/pos/khong-ton-tai`, {
      headers: { 'x-correlation-id': id, authorization: await bearer() },
    });
    const body = await expectErrorBody(response, 404, 'NOT_FOUND');

    assert.equal(body.correlationId, id);
    assert.match(String(body.message), /\/pos\/khong-ton-tai/);
    assert.ok((await waitForLogs(sales, id)).length > 0);
  });

  it('header x-user-* của client không tới sales, header khác vẫn tới', async () => {
    const id = randomUUID();
    await fetch(`${gatewayUrl}/api/pos/thu`, {
      headers: {
        'x-correlation-id': id,
        authorization: await bearer(),
        'x-user-role': 'ADMIN',
        'x-user-id': '1',
        'x-khac': 'co',
      },
    });
    const logged = (await waitForLogs(sales, id)) as LoggedRequest[];
    const headers = logged.find((line) => line.req?.headers)?.req?.headers ?? {};

    assert.equal(headers['x-khac'], 'co');
    assert.equal(headers['x-correlation-id'], id);
    assert.ok(!Object.keys(headers).some((name) => name.startsWith('x-user-')));
  });

  it('đường không khớp bảng: 404 NOT_FOUND', async () => {
    for (const path of ['/api/khong-co', '/khong-co', '/webhooks/khac', '/api']) {
      await expectErrorBody(await fetch(`${gatewayUrl}${path}`), 404, 'NOT_FOUND');
    }
    assert.equal(seen.length, 0);
  });

  it('/internal/* và /health/* của service luôn 404, kể cả đi vòng qua tiền tố có cắt đường dẫn', async () => {
    const paths = [
      '/internal/ping',
      '/INTERNAL/ping',
      '/api/admin/inventory/internal/ping',
      '/api/admin/inventory/INTERNAL/ping',
      '/api/admin/inventory/%69nternal/ping',
      '/api/admin/inventory/%2e%2e/internal/ping',
      '/api/admin/inventory//internal/ping',
      '/api/admin/inventory/health/ready',
      '/api/admin/inventory/%68ealth/live',
    ];
    for (const path of paths) {
      await expectErrorBody(await fetch(`${gatewayUrl}${path}`), 404, 'NOT_FOUND');
      const withToken = await fetch(`${gatewayUrl}${path}`, {
        headers: { authorization: await bearer() },
      });
      await expectErrorBody(withToken, 404, 'NOT_FOUND');
    }
    assert.deepEqual(seen, []);
  });

  it('body nhị phân đi nguyên byte, query được giữ, Authorization được giữ', async () => {
    const payload = randomBytes(64 * 1024);
    const token = await bearer();
    const response = await fetch(`${gatewayUrl}/api/admin/inventory/products?a=1&b=x%20y`, {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/octet-stream' },
      body: payload,
    });

    assert.equal(response.status, 200);
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.url, '/admin/products?a=1&b=x%20y');
    assert.equal(seen[0]?.headers.authorization, token);
    assert.equal(seen[0]?.headers['content-type'], 'application/octet-stream');
    assert.equal(seen[0]?.sha256, createHash('sha256').update(payload).digest('hex'));
  });

  it('trả nguyên status, body, set-cookie; body gzip của service vẫn đọc được', async () => {
    const compressed = gzipSync(JSON.stringify({ ok: true }));
    reply = (res) => {
      res
        .writeHead(201, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'set-cookie': ['a=1; HttpOnly', 'b=2'],
        })
        .end(compressed);
    };
    const response = await fetch(`${gatewayUrl}/api/auth/login`, { method: 'POST' });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(response.headers.getSetCookie(), ['a=1; HttpOnly', 'b=2']);
    assert.equal(seen[0]?.url, '/auth/login');
  });

  it('gateway không retry: service trả 503 thì đi thẳng về client sau một lần gọi', async () => {
    reply = (res) => void res.writeHead(503).end('dang bao tri');
    const response = await fetch(`${gatewayUrl}/api/auth/x`, { method: 'POST' });

    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'dang bao tri');
    assert.equal(seen.length, 1);
  });

  it('service không kết nối được: 503 SERVICE_UNAVAILABLE', async () => {
    const response = await fetch(`${gatewayUrl}/api/admin/reports/daily`, {
      headers: { authorization: await bearer() },
    });
    await expectErrorBody(response, 503, 'SERVICE_UNAVAILABLE');
  });

  it('body đúng 1 MB qua được, vượt thì 413 định dạng chung và không tới service', async () => {
    const limit = 1024 * 1024;
    const ok = await fetch(`${gatewayUrl}/api/auth/x`, {
      method: 'POST',
      body: Buffer.alloc(limit),
    });
    assert.equal(ok.status, 200);
    assert.equal(seen[0]?.size, limit);

    seen = [];
    const declared = await fetch(`${gatewayUrl}/api/auth/x`, {
      method: 'POST',
      body: Buffer.alloc(limit + 1),
    });
    await expectErrorBody(declared, 413, 'PAYLOAD_TOO_LARGE');

    const chunked = await fetch(`${gatewayUrl}/api/auth/x`, {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(limit + 1));
          controller.close();
        },
      }),
    } as RequestInit);
    await expectErrorBody(chunked, 413, 'PAYLOAD_TOO_LARGE');
    assert.equal(seen.length, 0);
  });

  it('body JSON hỏng tới service: 400 VALIDATION_FAILED, vẫn có correlationId của gateway', async () => {
    const id = randomUUID();
    const response = await fetch(`${gatewayUrl}/api/pos/x`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': id,
        authorization: await bearer(),
      },
      body: '{hong',
    });
    const body = await expectErrorBody(response, 400, 'VALIDATION_FAILED');
    assert.equal(body.correlationId, id);
  });

  it('/health/* giữ nguyên body, không theo định dạng lỗi chung', async () => {
    const live = await fetch(`${gatewayUrl}/health/live`);
    assert.deepEqual(await live.json(), { status: 'ok' });
  });
});

describe('/health/ready khi không có Postgres và RabbitMQ', () => {
  it('503 với body {status, checks}', async () => {
    const port = await freePort();
    const inventory = startService('inventory', {
      PORT: String(port),
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test?schema=inventory',
    });
    try {
      await waitUntilLive(port);
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        status: 'error',
        checks: { postgres: 'down', rabbitmq: 'down' },
      });
    } finally {
      inventory.child.kill();
    }
  });
});
