import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createTestKeys, TEST_AUDIENCE, TEST_ISSUER, type TestKeys } from '@jewelry/test-utils';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const STARTUP_TIMEOUT_MS = 15_000;
export interface LogLine {
  service?: string;
  correlationId?: string | null;
  msg?: string;
}

export interface RunningService {
  child: ChildProcess;
  logs: LogLine[];
}

export const testKeys: TestKeys = createTestKeys();

/** Khoá tạm cho mỗi lần chạy, không dùng secrets/: test không phụ thuộc khoá thật. */
export const JWT_ENV = {
  JWT_PUBLIC_KEYS_DIR: testKeys.publicKeysDir,
  JWT_ISSUER: TEST_ISSUER,
  JWT_AUDIENCE: TEST_AUDIENCE,
  // Cổng đóng: các test này không cần RabbitMQ, service vẫn chạy và tự thử kết nối lại.
  RABBITMQ_URL: 'amqp://test:test@127.0.0.1:1',
};

export function freePort(): Promise<number> {
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

/** Dữ liệu chẩn đoán theo cổng: service không lên thì thông báo lỗi phải nói được vì sao. */
const started = new Map<string, { app: string; service: RunningService; stderr: string[] }>();

export function startService(app: string, env: Record<string, string>): RunningService {
  const child = spawn(process.execPath, [resolve(REPO_ROOT, `apps/${app}/dist/main.js`)], {
    cwd: import.meta.dirname,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', ...JWT_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: LogLine[] = [];
  const stderr: string[] = [];
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
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const service = { child, logs };
  if (env.PORT !== undefined) {
    started.set(env.PORT, { app, service, stderr });
  }
  return service;
}

function describeFailure(port: number): string {
  const entry = started.get(String(port));
  if (entry === undefined) {
    return '';
  }
  const { app, service, stderr } = entry;
  const lastLogs = service.logs.slice(-3).map((line) => line.msg);
  return ` (${app}, exitCode=${service.child.exitCode}, stderr=${stderr.join('').slice(-400)}, log cuối=${JSON.stringify(lastLogs)})`;
}

export async function waitUntilLive(port: number): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? (error.cause ?? error) : error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(
    `Service ở cổng ${port} không lên trong ${STARTUP_TIMEOUT_MS} ms: ${String(lastError)}${describeFailure(port)}`,
  );
}

export async function waitForLogs(
  service: RunningService,
  correlationId: string,
): Promise<LogLine[]> {
  const deadline = Date.now() + 2000;
  const matching = () => service.logs.filter((line) => line.correlationId === correlationId);
  while (Date.now() < deadline && matching().length === 0) {
    await new Promise((done) => setTimeout(done, 20));
  }
  return matching();
}
