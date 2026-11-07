// Chạy trên Postgres thật: pnpm test:auth. Service `auth`, `gateway` là bản build thật.
// Chỉ đụng vào user và lần thử có email thuộc TEST_EMAIL_DOMAIN; chạy xong số dòng mọi bảng phải y như trước.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { createTestKeys, signTestToken } from '@jewelry/test-utils';
import {
  authServiceEnv,
  createDb,
  keys,
  migrate,
  REPO_ROOT,
  type RunningService,
  startFakeGoogle,
  startService,
  stopService,
  TEST_EMAIL_DOMAIN,
  type TestDb,
  type TestUser,
} from './support.ts';

const appRequire = createRequire(resolve(REPO_ROOT, 'apps/auth/package.json'));
const { hash } = appRequire('bcryptjs') as { hash(value: string, rounds: number): Promise<string> };
const { deleteStaleRefreshTokens } = appRequire('./dist/session/refresh-token-cleanup.js') as {
  deleteStaleRefreshTokens(db: unknown): Promise<number>;
};

const PASSWORD = 'mat-khau-dung-cua-admin';
const NEW_PASSWORD = 'mat-khau-moi-cua-admin';
const TEST_BRANCH = 'AUTHTEST';
const MINUTE_RETRY = /^[1-9]\d?$/;
const TEST_USERS = { where: { email: { endsWith: TEST_EMAIL_DOMAIN } } };
const TEST_ATTEMPTS = {
  where: {
    entityType: 'LoginAttempt',
    data: { path: ['email'], string_ends_with: TEST_EMAIL_DOMAIN },
  },
};

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/** fetch không chọn được địa chỉ nguồn. 127.0.0.x đều là loopback trên Linux, nên giả được nhiều IP client. */
function postFrom(
  url: string,
  path: string,
  sourceIp: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((done, fail) => {
    const payload = JSON.stringify(body);
    const target = new URL(path, url);
    const outgoing = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        localAddress: sourceIp,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk: Buffer) => (text += chunk.toString()));
        response.on('end', () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
          }),
        );
      },
    );
    outgoing.on('error', fail);
    outgoing.end(payload);
  });
}

describe('đăng nhập mật khẩu, đổi mật khẩu, rate limit', () => {
  let db: TestDb;
  let auth: RunningService;
  let gateway: RunningService;
  let trustingGateway: RunningService;
  let fakeGoogle: Server;
  let passwordHash: string;
  let branchId: string;
  let baseline: unknown;
  let nextIp = 10;
  const secrets = new Set([PASSWORD, NEW_PASSWORD]);

  /** Mỗi test một IP nguồn riêng, để bộ đếm của gateway không ảnh hưởng lẫn nhau. */
  const freshIp = () => {
    nextIp += 1;
    return `127.0.0.${nextIp}`;
  };

  const counts = async () => ({
    users: await db.user.count(),
    tokens: await db.refreshToken.count(),
    audits: await db.auditLog.count(),
    roles: await db.userBranch.count(),
  });

  const removeTestData = async () => {
    const ids = (await db.user.findMany(TEST_USERS)).map((user) => user.id);
    const byUser = { where: { userId: { in: ids } } };
    await db.refreshToken.deleteMany(byUser);
    await db.authIdentity.deleteMany(byUser);
    await db.userBranch.deleteMany(byUser);
    await db.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await db.auditLog.deleteMany(TEST_ATTEMPTS);
    await db.user.deleteMany({ where: { id: { in: ids } } });
  };

  const removeBranch = () =>
    db.$executeRawUnsafe(`DELETE FROM "auth"."Branch" WHERE code = '${TEST_BRANCH}'`);

  before(async () => {
    migrate();
    db = createDb();
    await removeTestData();
    await removeBranch();
    baseline = await counts();
    passwordHash = await hash(PASSWORD, 12);
    const [branch] = await (
      db as unknown as {
        $queryRawUnsafe<T>(query: string): Promise<T>;
      }
    ).$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "auth"."Branch" (id, code, name) VALUES (gen_random_uuid(), '${TEST_BRANCH}', 'Thử') RETURNING id`,
    );
    branchId = branch?.id ?? '';
    const { server, url } = await startFakeGoogle();
    fakeGoogle = server;
    auth = await startService('auth', authServiceEnv(url));
    const gatewayEnv = {
      AUTH_URL: auth.url,
      INVENTORY_URL: 'http://127.0.0.1:1',
      SALES_URL: 'http://127.0.0.1:1',
      REPORT_URL: 'http://127.0.0.1:1',
    };
    gateway = await startService('gateway', { ...gatewayEnv, TRUSTED_PROXIES: '' });
    trustingGateway = await startService('gateway', {
      ...gatewayEnv,
      TRUSTED_PROXIES: '127.0.0.0/24',
    });
  });

  after(async () => {
    try {
      await Promise.all([gateway, trustingGateway, auth].map(stopService));
      fakeGoogle?.closeAllConnections();
      fakeGoogle?.close();
      await removeTestData();
      await removeBranch();
      assert.deepEqual(await counts(), baseline, 'dữ liệu phải giống hệt trước khi chạy');
    } finally {
      await db?.$disconnect();
    }
  });

  afterEach(removeTestData);

  const email = () => `${randomUUID()}${TEST_EMAIL_DOMAIN}`;

  const createAdmin = (
    options: { hash?: string | null; status?: string } = {},
  ): Promise<TestUser> =>
    db.user.create({
      data: {
        email: email(),
        fullName: 'Quản Trị',
        passwordHash: options.hash === undefined ? passwordHash : options.hash,
        status: options.status ?? 'ACTIVE',
        branches: { create: { role: 'ADMIN' } },
      },
    });

  const createStaff = (): Promise<TestUser> =>
    db.user.create({
      data: {
        email: email(),
        fullName: 'Nhân Viên',
        passwordHash,
        branches: { create: { role: 'STAFF', branchId } },
      },
    });

  const login = (address: string, password: string) =>
    fetch(`${auth.url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify({ email: address, password }),
    });

  const cookieOf = (response: Response) => {
    const header = response.headers.getSetCookie().find((c) => c.startsWith('rt_bo='));
    assert.ok(header, 'phải đặt cookie rt_bo');
    const value = header.slice('rt_bo='.length, header.indexOf(';'));
    secrets.add(value);
    return value;
  };

  const loginOk = async (user: TestUser, password = PASSWORD) => {
    const response = await login(user.email, password);
    assert.equal(response.status, 200);
    const { accessToken } = (await response.json()) as { accessToken: string };
    secrets.add(accessToken);
    return { accessToken, cookie: cookieOf(response) };
  };

  const changePassword = (accessToken: string, body: Record<string, string>, cookie?: string) =>
    fetch(`${auth.url}/auth/change-password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        ...(cookie === undefined ? {} : { cookie: `rt_bo=${cookie}` }),
      },
      body: JSON.stringify(body),
    });

  const refresh = (cookie: string) =>
    fetch(`${auth.url}/auth/refresh`, { method: 'POST', headers: { cookie: `rt_bo=${cookie}` } });

  const auditsOf = (entityId: string) => db.auditLog.findMany({ where: { entityId } });

  const withoutCorrelation = async (response: Response) => {
    const { correlationId, ...rest } = (await response.json()) as Record<string, unknown>;
    assert.equal(typeof correlationId, 'string');
    return rest;
  };

  describe('đăng nhập', () => {
    it('ADMIN đúng mật khẩu: 200, access token dùng được, cookie, AuditLog thành công', async () => {
      const user = await createAdmin();
      const { accessToken } = await loginOk(user);

      const me = await fetch(`${auth.url}/auth/me`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      assert.equal(((await me.json()) as { id: string }).id, user.id);
      const audits = await auditsOf(user.id);
      assert.deepEqual(
        audits.map((audit) => audit.action),
        ['auth.password_login_succeeded'],
      );
      assert.deepEqual(audits[0]?.data, { email: user.email, ip: '198.51.100.7' });
    });

    it('email không phân biệt hoa thường', async () => {
      const user = await createAdmin();
      assert.equal((await login(user.email.toUpperCase(), PASSWORD)).status, 200);
    });

    it('mọi trường hợp thất bại: cùng 401, cùng body, đều có AuditLog', async () => {
      const admin = await createAdmin();
      const staff = await createStaff();
      const locked = await createAdmin({ status: 'LOCKED' });
      const noPassword = await createAdmin({ hash: null });
      const unknown = email();
      const cases: [string, string][] = [
        [admin.email, 'sai-mat-khau-hoan-toan'],
        [unknown, PASSWORD],
        [staff.email, PASSWORD],
        [locked.email, PASSWORD],
        [noPassword.email, PASSWORD],
      ];

      const bodies = [];
      for (const [address, password] of cases) {
        const response = await login(address, password);
        assert.equal(response.status, 401, address);
        assert.deepEqual(response.headers.getSetCookie(), []);
        bodies.push(await withoutCorrelation(response));
      }

      assert.deepEqual(bodies[0], {
        code: 'INVALID_CREDENTIALS',
        message: 'Sai email hoặc mật khẩu',
      });
      for (const body of bodies) {
        assert.deepEqual(body, bodies[0]);
      }
      for (const user of [admin, staff, locked, noPassword]) {
        const audits = await auditsOf(user.id);
        assert.deepEqual(
          audits.map((audit) => audit.action),
          ['auth.password_login_failed'],
          user.email,
        );
        assert.deepEqual(audits[0]?.data, { email: user.email, ip: '198.51.100.7' });
      }
      const attempts = await db.auditLog.findMany(TEST_ATTEMPTS);
      assert.deepEqual(
        attempts.map((audit) => [audit.action, audit.actorId, audit.data]),
        [['auth.password_login_failed', null, { email: unknown, ip: '198.51.100.7' }]],
      );
      assert.equal(await db.refreshToken.count({ where: { userId: admin.id } }), 0);
    });

    it('thiếu email hoặc mật khẩu: 400', async () => {
      const response = await fetch(`${auth.url}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'khong-phai-email' }),
      });
      assert.equal(response.status, 400);
    });

    it('thời gian phản hồi: email lạ và sai mật khẩu chênh lệch nhỏ', async (context) => {
      const admin = await createAdmin();
      const staff = await createStaff();
      const samples = 12;
      const time = async (address: string, password: string) => {
        const started = performance.now();
        assert.equal((await login(address, password)).status, 401);
        return performance.now() - started;
      };
      const measured: Record<string, number[]> = { wrong: [], unknown: [], staff: [] };
      await time(email(), PASSWORD); // bỏ lần đầu: JIT
      for (let index = 0; index < samples; index += 1) {
        // Xen kẽ để biến động của máy tác động đều lên các nhóm.
        measured.wrong?.push(await time(admin.email, 'sai-mat-khau-hoan-toan'));
        measured.unknown?.push(await time(email(), PASSWORD));
        measured.staff?.push(await time(staff.email, PASSWORD));
      }
      const mean = (values: number[] = []) => values.reduce((sum, v) => sum + v, 0) / values.length;
      const wrong = mean(measured.wrong);
      const unknown = mean(measured.unknown);
      const notAdmin = mean(measured.staff);
      context.diagnostic(
        `Trung bình ${samples} lần: sai mật khẩu ${wrong.toFixed(1)} ms, email lạ ${unknown.toFixed(1)} ms, không phải ADMIN ${notAdmin.toFixed(1)} ms`,
      );
      for (const value of [unknown, notAdmin]) {
        assert.ok(
          Math.abs(value - wrong) / wrong < 0.2,
          `chênh lệch lớn: ${wrong} so với ${value}`,
        );
      }
    });
  });

  describe('đổi mật khẩu', () => {
    it('thu hồi phiên khác, giữ phiên hiện tại, mật khẩu cũ hết tác dụng, có AuditLog', async () => {
      const user = await createAdmin();
      const other = await loginOk(user);
      const current = await loginOk(user);

      const response = await changePassword(
        current.accessToken,
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        current.cookie,
      );

      assert.equal(response.status, 204);
      assert.equal((await refresh(other.cookie)).status, 401);
      const kept = await refresh(current.cookie);
      assert.equal(kept.status, 200, 'phiên hiện tại phải còn');
      cookieOf(kept);
      assert.equal((await login(user.email, PASSWORD)).status, 401);
      assert.equal((await login(user.email, NEW_PASSWORD)).status, 200);

      const changed = await db.user.findUnique({ where: { id: user.id } });
      assert.notEqual(changed?.passwordHash, passwordHash);
      const audits = await auditsOf(user.id);
      assert.ok(audits.some((audit) => audit.action === 'auth.password_changed'));
    });

    it('sai mật khẩu hiện tại: 401, không đổi gì, phiên không bị thu hồi', async () => {
      const user = await createAdmin();
      const session = await loginOk(user);
      const response = await changePassword(session.accessToken, {
        currentPassword: 'sai-mat-khau-hoan-toan',
        newPassword: NEW_PASSWORD,
      });
      assert.equal(response.status, 401);
      assert.equal(((await response.json()) as { code: string }).code, 'INVALID_CREDENTIALS');
      assert.equal((await refresh(session.cookie)).status, 200);
      assert.equal(
        (await db.user.findUnique({ where: { id: user.id } }))?.passwordHash,
        passwordHash,
      );
    });

    it('mật khẩu mới yếu, quá 72 byte, hoặc trùng mật khẩu cũ: 400 PASSWORD_TOO_WEAK', async () => {
      const user = await createAdmin();
      const { accessToken } = await loginOk(user);
      for (const newPassword of ['ngan', 'a'.repeat(73), PASSWORD]) {
        const response = await changePassword(accessToken, {
          currentPassword: PASSWORD,
          newPassword,
        });
        assert.equal(response.status, 400, newPassword);
        assert.equal(((await response.json()) as { code: string }).code, 'PASSWORD_TOO_WEAK');
      }
      assert.equal(
        (await db.user.findUnique({ where: { id: user.id } }))?.passwordHash,
        passwordHash,
      );
    });

    it('không phải ADMIN: 403 FORBIDDEN; không có token: 401', async () => {
      const staff = await createStaff();
      const token = await signTestToken(keys.privateKey, {
        claims: { sub: staff.id, branches: [{ branchId, role: 'STAFF' }] },
      });
      secrets.add(token);
      const response = await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as { code: string }).code, 'FORBIDDEN');
      const anonymous = await fetch(`${auth.url}/auth/change-password`, { method: 'POST' });
      assert.equal(anonymous.status, 401);
    });

    it('hai lần đổi song song: một bên thắng, không để lại trạng thái lạ', async () => {
      const user = await createAdmin();
      const { accessToken } = await loginOk(user);
      const body = (newPassword: string) => ({ currentPassword: PASSWORD, newPassword });
      const responses = await Promise.all([
        changePassword(accessToken, body(`${NEW_PASSWORD}-mot`)),
        changePassword(accessToken, body(`${NEW_PASSWORD}-hai`)),
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [204, 401]);
      const changes = (await auditsOf(user.id)).filter((a) => a.action === 'auth.password_changed');
      assert.equal(changes.length, 1);
    });
  });

  describe('job dọn RefreshToken', () => {
    it('chỉ xoá token đã thu hồi hoặc đã hết hạn quá 30 ngày', async () => {
      const user = await createAdmin();
      const rows: Record<string, string> = {
        recentRevoked: `"revokedAt" = now() - interval '29 days'`,
        oldRevoked: `"revokedAt" = now() - interval '31 days'`,
        recentExpired: `"expiresAt" = now() - interval '29 days'`,
        oldExpired: `"expiresAt" = now() - interval '31 days'`,
        active: `"expiresAt" = now() + interval '7 days'`,
      };
      const ids: Record<string, string> = {};
      for (const [name, assignment] of Object.entries(rows)) {
        const id = randomUUID();
        ids[name] = id;
        await db.$executeRawUnsafe(
          `INSERT INTO "auth"."RefreshToken" (id, "userId", "tokenHash", "expiresAt", "sessionStartedAt")
           VALUES ($1::uuid, $2::uuid, $3, now() + interval '1 day', now())`,
          id,
          user.id,
          randomUUID(),
        );
        await db.$executeRawUnsafe(
          `UPDATE "auth"."RefreshToken" SET ${assignment} WHERE id = $1::uuid`,
          id,
        );
      }

      const deleted = await deleteStaleRefreshTokens(db);

      assert.equal(deleted >= 2, true);
      const left = (await db.refreshToken.findMany({ where: { userId: user.id } })).map(
        (t) => t.id,
      );
      assert.deepEqual(
        left.sort(),
        [ids.recentRevoked, ids.recentExpired, ids.active].sort() as string[],
      );
    });
  });

  describe('qua gateway, bản build thật', () => {
    const failLogin = (url: string, ip: string, address: string, headers = {}) =>
      postFrom(
        url,
        '/api/auth/login',
        ip,
        { email: address, password: 'sai-mat-khau-hoan-toan' },
        headers,
      );

    it('lần thứ 6 sai mật khẩu trong một phút: 429 có Retry-After, định dạng lỗi chung', async () => {
      const user = await createAdmin();
      const ip = freshIp();
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        assert.equal((await failLogin(gateway.url, ip, user.email)).status, 401, `lần ${attempt}`);
      }
      const blocked = await failLogin(gateway.url, ip, user.email);

      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.code, 'RATE_LIMITED');
      assert.equal(typeof blocked.body.correlationId, 'string');
      assert.match(String(blocked.headers['retry-after']), MINUTE_RETRY);
      assert.equal((await auditsOf(user.id)).length, 5, 'lần bị chặn không được tới auth');
    });

    it('IP khác vẫn đăng nhập được khi một IP đã bị chặn', async () => {
      const user = await createAdmin();
      const blockedIp = freshIp();
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await failLogin(gateway.url, blockedIp, user.email);
      }
      const other = await postFrom(gateway.url, '/api/auth/login', freshIp(), {
        email: user.email,
        password: PASSWORD,
      });
      assert.equal(other.status, 200);
      secrets.add(String(other.body.accessToken));
    });

    it('X-Forwarded-For giả gửi thẳng tới gateway không đổi được IP đếm và IP ghi nhận', async () => {
      const user = await createAdmin();
      const ip = freshIp();
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const reply = await failLogin(gateway.url, ip, user.email, {
          'x-forwarded-for': `203.0.113.${attempt}`,
          'x-real-ip': `203.0.113.${attempt}`,
        });
        assert.equal(reply.status, 401);
      }
      const blocked = await failLogin(gateway.url, ip, user.email, {
        'x-forwarded-for': '203.0.113.99',
      });
      assert.equal(blocked.status, 429);
      const ips = (await auditsOf(user.id)).map((audit) => (audit.data as { ip: string }).ip);
      assert.deepEqual([...new Set(ips)], [ip]);
    });

    it('không lách được bằng cách viết đường dẫn hoặc email khác', async () => {
      const user = await createAdmin();
      const ip = freshIp();
      const variants = [
        ['/api/auth/login', user.email],
        ['/api/auth/LOGIN', user.email],
        ['/api/auth/login/', user.email],
        ['/api/auth/login', user.email.toUpperCase()],
        ['/api/auth/Login/', user.email],
      ];
      for (const [path, address] of variants) {
        const reply = await postFrom(gateway.url, path as string, ip, {
          email: address,
          password: 'sai-mat-khau-hoan-toan',
        });
        assert.equal(reply.status, 401, path);
      }
      assert.equal((await failLogin(gateway.url, ip, user.email)).status, 429);
    });

    it('login: 20 lần mỗi phút theo IP, dù đổi email', async () => {
      const ip = freshIp();
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        assert.equal((await failLogin(gateway.url, ip, email())).status, 401, `lần ${attempt}`);
      }
      assert.equal((await failLogin(gateway.url, ip, email())).status, 429);
    });

    it('google: 20 lần mỗi phút theo IP', async () => {
      const ip = freshIp();
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        const reply = await postFrom(gateway.url, '/api/auth/google', ip, { credential: 'sai' });
        assert.equal(reply.status, 401, `lần ${attempt}`);
      }
      const blocked = await postFrom(gateway.url, '/api/auth/google', ip, { credential: 'sai' });
      assert.equal(blocked.status, 429);
      assert.match(String(blocked.headers['retry-after']), MINUTE_RETRY);
    });

    it('refresh: 60 lần mỗi phút theo IP', async () => {
      const ip = freshIp();
      for (let attempt = 1; attempt <= 60; attempt += 1) {
        const reply = await postFrom(gateway.url, '/api/auth/refresh', ip, {});
        assert.equal(reply.status, 401, `lần ${attempt}`);
      }
      assert.equal((await postFrom(gateway.url, '/api/auth/refresh', ip, {})).status, 429);
    });

    describe('đổi mật khẩu', () => {
      const attempt = (ip: string, token: string, currentPassword = 'sai-mat-khau-hoan-toan') =>
        postFrom(
          gateway.url,
          '/api/auth/change-password',
          ip,
          { currentPassword, newPassword: NEW_PASSWORD },
          { authorization: `Bearer ${token}` },
        );

      it('sai lần thứ 6 trong 15 phút: 429, kể cả đổi IP; user khác không ảnh hưởng', async () => {
        const user = await createAdmin();
        const other = await createAdmin();
        const { accessToken } = await loginOk(user);
        const ip = freshIp();

        for (let time = 1; time <= 5; time += 1) {
          assert.equal((await attempt(ip, accessToken)).status, 401, `lần ${time}`);
        }
        const blocked = await attempt(ip, accessToken);

        assert.equal(blocked.status, 429);
        assert.equal(blocked.body.code, 'RATE_LIMITED');
        const retryAfter = Number(blocked.headers['retry-after']);
        assert.ok(retryAfter > 60 && retryAfter <= 900, `Retry-After = ${retryAfter}`);
        assert.equal((await attempt(freshIp(), accessToken)).status, 429, 'đổi IP không lách được');

        const session = await loginOk(other);
        assert.equal((await attempt(freshIp(), session.accessToken)).status, 401);
      });

      it('lần bị chặn không tới auth: mật khẩu đúng cũng không đổi được', async () => {
        const user = await createAdmin();
        const { accessToken } = await loginOk(user);
        const ip = freshIp();
        for (let time = 1; time <= 5; time += 1) {
          await attempt(ip, accessToken);
        }
        assert.equal((await attempt(ip, accessToken, PASSWORD)).status, 429);
        const stored = await db.user.findUnique({ where: { id: user.id } });
        assert.equal(stored?.passwordHash, passwordHash);
      });

      it('không lách được bằng cách viết đường dẫn khác', async () => {
        const user = await createAdmin();
        const { accessToken } = await loginOk(user);
        const ip = freshIp();
        for (const path of [
          '/api/auth/change-password',
          '/api/auth/CHANGE-PASSWORD',
          '/api/auth/change-password/',
          '/api/auth/Change-Password/',
          '/api/auth/change-password',
        ]) {
          const reply = await postFrom(
            gateway.url,
            path,
            ip,
            { currentPassword: 'sai-mat-khau-hoan-toan', newPassword: NEW_PASSWORD },
            { authorization: `Bearer ${accessToken}` },
          );
          assert.equal(reply.status, 401, path);
        }
        assert.equal((await attempt(ip, accessToken)).status, 429);
      });

      it('token giả không khoá được user khác: 401 ở gateway, không tính vào bộ đếm', async () => {
        const victim = await createAdmin();
        const { accessToken } = await loginOk(victim);
        const stranger = createTestKeys();
        const forged = await signTestToken(stranger.privateKey, { claims: { sub: victim.id } });
        const ip = freshIp();
        for (let time = 1; time <= 8; time += 1) {
          assert.equal((await attempt(ip, forged)).status, 401);
        }
        assert.equal((await attempt(freshIp(), accessToken)).status, 401, 'vẫn chưa bị chặn');
      });

      it('20 lần mỗi phút theo IP, dù đổi user', async () => {
        const ip = freshIp();
        const token = (sub: string) => signTestToken(keys.privateKey, { claims: { sub } });
        for (let time = 1; time <= 20; time += 1) {
          const reply = await attempt(ip, await token(randomUUID()));
          assert.equal(reply.status, 401, `lần ${time}`);
        }
        assert.equal((await attempt(ip, await token(randomUUID()))).status, 429);
      });
    });

    it('proxy tin cậy: X-Forwarded-For được dùng, phần client giả ở đầu chuỗi bị bỏ qua', async () => {
      const user = await createAdmin();
      const reply = await postFrom(
        trustingGateway.url,
        '/api/auth/login',
        freshIp(),
        { email: user.email, password: PASSWORD },
        { 'x-forwarded-for': '203.0.113.50, 198.51.100.23' },
      );
      assert.equal(reply.status, 200);
      secrets.add(String(reply.body.accessToken));
      const [token] = await db.refreshToken.findMany({ where: { userId: user.id } });
      assert.equal(token?.ip, '198.51.100.23');
      const [audit] = await auditsOf(user.id);
      assert.deepEqual(audit?.data, { email: user.email, ip: '198.51.100.23' });
    });

    it('proxy tin cậy: đếm theo IP thật của từng người dùng, không theo IP proxy', async () => {
      const user = await createAdmin();
      const ip = freshIp();
      for (let client = 1; client <= 8; client += 1) {
        const reply = await failLogin(trustingGateway.url, ip, user.email, {
          'x-forwarded-for': `198.51.100.${client}`,
        });
        assert.equal(reply.status, 401, `người dùng ${client}`);
      }
    });
  });

  it('không có mật khẩu hay token trong log và AuditLog', async () => {
    const logs = [...auth.output, ...gateway.output, ...trustingGateway.output].join('');
    assert.ok(logs.includes('request completed'), 'log phải có thật');
    for (const secret of secrets) {
      assert.ok(!logs.includes(secret), 'có bí mật trong log');
    }
    assert.ok(!logs.includes('"password"'), 'log không được chứa trường password');
  });
});
