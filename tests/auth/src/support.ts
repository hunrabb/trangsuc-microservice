// Hạ tầng thật: Postgres của Docker Compose. Service `auth` và `gateway` là bản build thật, Google là server giả.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  createGoogleIssuer,
  createTestKeyFiles,
  TEST_AUDIENCE_BACKOFFICE,
  TEST_AUDIENCE_SHOP,
  TEST_ISSUER,
} from '@jewelry/test-utils';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(REPO_ROOT, '.env'));

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Thiếu ${name} trong .env`);
  }
  return value;
};

export const DATABASE_URL = `postgresql://auth_user:${required('AUTH_DB_PASSWORD')}@127.0.0.1:5432/${required('POSTGRES_DB')}?schema=auth`;
export const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
/** Mọi user của test đều dùng tên miền này: dọn dữ liệu theo đúng phạm vi đó. */
export const TEST_EMAIL_DOMAIN = '@auth-test.jewelry.invalid';

export const keys = createTestKeyFiles();
export const google = createGoogleIssuer();

/** Cổng đóng: phiên đăng nhập không cần RabbitMQ, và worker outbox của auth không chạm vào bảng khi mất kết nối. */
const NO_RABBIT = 'amqp://test:test@127.0.0.1:1';

export interface TestUser {
  id: string;
  email: string;
  status: string;
}

// Kiểu tối thiểu cho Prisma client lấy từ bản build của app.
export interface TestDb {
  $disconnect(): Promise<void>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  user: {
    create(args: unknown): Promise<TestUser>;
    findMany(args?: unknown): Promise<(TestUser & { passwordHash: string | null })[]>;
    findUnique(args: unknown): Promise<(TestUser & { passwordHash: string | null }) | null>;
    update(args: unknown): Promise<unknown>;
    deleteMany(args?: unknown): Promise<unknown>;
    count(args?: unknown): Promise<number>;
  };
  userBranch: {
    deleteMany(args?: unknown): Promise<unknown>;
    count(args?: unknown): Promise<number>;
    findMany(args?: unknown): Promise<{ branchId: string | null; role: string }[]>;
  };
  refreshToken: {
    findMany(args?: unknown): Promise<
      {
        id: string;
        tokenHash: string;
        revokedAt: Date | null;
        replacedAt: Date | null;
        sessionStartedAt: Date;
        expiresAt: Date;
        userAgent: string | null;
        ip: string | null;
      }[]
    >;
    deleteMany(args?: unknown): Promise<unknown>;
    count(args?: unknown): Promise<number>;
  };
  authIdentity: {
    findMany(args?: unknown): Promise<{ subject: string; userId: string }[]>;
    deleteMany(args?: unknown): Promise<unknown>;
    count(args?: unknown): Promise<number>;
  };
  auditLog: {
    findMany(args?: unknown): Promise<{ action: string; actorId: string | null; data: unknown }[]>;
    deleteMany(args?: unknown): Promise<unknown>;
    count(args?: unknown): Promise<number>;
  };
  outboxEvent: { count(args?: unknown): Promise<number> };
}

export function createDb(): TestDb {
  const appRequire = createRequire(resolve(REPO_ROOT, 'apps/auth/package.json'));
  const { PrismaPg } = appRequire('@prisma/adapter-pg');
  const { PrismaClient } = appRequire('./dist/generated/prisma/client.js');
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema: 'auth' }),
  }) as TestDb;
}

export function migrate(): void {
  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(REPO_ROOT, 'apps/auth'),
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy lỗi: ${result.stdout}${result.stderr}`);
  }
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
}

/** Server JWKS giả. Trả về địa chỉ và server để đóng sau khi chạy. */
export async function startFakeGoogle(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(google.jwks));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks` };
}

export interface RunningService {
  child: ChildProcess;
  /** Toàn bộ log thô, để kiểm tra không có token. */
  output: string[];
  url: string;
}

const JWT_ENV = {
  JWT_PUBLIC_KEYS_DIR: keys.publicKeysDir,
  JWT_ISSUER: TEST_ISSUER,
  JWT_AUDIENCE_BACKOFFICE: TEST_AUDIENCE_BACKOFFICE,
  JWT_AUDIENCE_SHOP: TEST_AUDIENCE_SHOP,
};

export async function startService(
  app: 'auth' | 'gateway',
  env: Record<string, string>,
): Promise<RunningService> {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(REPO_ROOT, `apps/${app}/dist/main.js`)], {
    cwd: import.meta.dirname,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), ...JWT_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/health/live`)).ok) {
        return { child, output, url };
      }
    } catch {
      // chưa mở cổng
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${app} không lên, exitCode=${child.exitCode}: ${output.join('').slice(-600)}`,
      );
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

export const authServiceEnv = (jwksUrl: string): Record<string, string> => ({
  DATABASE_URL,
  DATABASE_POOL_MAX: '20',
  RABBITMQ_URL: NO_RABBIT,
  JWT_PRIVATE_KEY_PATH: keys.privateKeyPath,
  JWT_ACTIVE_KID: keys.kid,
  GOOGLE_CLIENT_ID,
  GOOGLE_JWKS_URL: jwksUrl,
});

export function stopService(service: RunningService | undefined): Promise<void> {
  return new Promise((done) => {
    if (service === undefined || service.child.exitCode !== null) {
      done();
      return;
    }
    service.child.once('close', () => done());
    service.child.kill();
  });
}

/** Chạy lệnh tạo ADMIN bản trong dist, đúng như trên server. */
export function adminCreate(
  args: string[],
  options: { password?: string; stdin?: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [resolve(REPO_ROOT, 'apps/auth/dist/cli/admin-create.js'), ...args],
    {
      cwd: import.meta.dirname,
      env: {
        PATH: process.env.PATH,
        DATABASE_URL,
        ...(options.password === undefined ? {} : { ADMIN_PASSWORD: options.password }),
      },
      input: options.stdin ?? '',
      encoding: 'utf8',
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
