import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

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

export function startService(app: string, env: Record<string, string>): RunningService {
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

export async function waitUntilLive(port: number): Promise<void> {
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
