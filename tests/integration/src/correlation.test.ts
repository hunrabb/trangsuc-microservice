// Chạy bản build thật của gateway và inventory rồi đọc log trên stdout, không mock gì.
// devDependencies `workspace:*` khiến turbo build hai app này trước. Không cần Postgres:
// /api/ping không chạm DB và Prisma chỉ kết nối khi có truy vấn đầu tiên.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const STARTUP_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f-]{36}$/;

interface LogLine {
  service?: string;
  correlationId?: string | null;
  msg?: string;
}

interface RunningService {
  child: ChildProcess;
  logs: LogLine[];
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

function startService(app: string, env: Record<string, string>): RunningService {
  const child = spawn(process.execPath, [resolve(REPO_ROOT, `apps/${app}/dist/main.js`)], {
    cwd: import.meta.dirname,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const logs: LogLine[] = [];
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() !== '') {
        logs.push(JSON.parse(line) as LogLine);
      }
    }
  });
  return { child, logs };
}

async function waitUntilLive(port: number): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (response.ok) {
        return;
      }
    } catch {
      // chưa mở cổng
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Service ở cổng ${port} không lên trong ${STARTUP_TIMEOUT_MS} ms`);
}

/** Dòng "request completed" được ghi sau khi phản hồi đã đi, nên phải chờ. */
async function waitForLogs(service: RunningService, correlationId: string): Promise<LogLine[]> {
  const deadline = Date.now() + 2000;
  const matching = () => service.logs.filter((line) => line.correlationId === correlationId);
  while (Date.now() < deadline && matching().length === 0) {
    await new Promise((done) => setTimeout(done, 20));
  }
  return matching();
}

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
      INVENTORY_URL: `http://127.0.0.1:${inventoryPort}`,
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
  it('thiếu biến thì log rõ tên biến và thoát mã 1', async () => {
    const service = startService('inventory', { PORT: '3999' });
    const code = await new Promise((done) => service.child.once('close', done));

    assert.equal(code, 1);
    assert.match(service.logs[0]?.msg ?? '', /DATABASE_URL \(thiếu biến\)/);
  });
});
