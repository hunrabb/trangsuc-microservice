// Chạy trên Postgres thật: pnpm test:auth (cùng hạ tầng với test messaging).
// Chỉ đụng vào user có email thuộc TEST_EMAIL_DOMAIN; chạy xong số dòng mọi bảng phải y như trước.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  adminCreate,
  authServiceEnv,
  createDb,
  GOOGLE_CLIENT_ID,
  google,
  migrate,
  type RunningService,
  startFakeGoogle,
  startService,
  stopService,
  TEST_EMAIL_DOMAIN,
  type TestDb,
  type TestUser,
} from './support.ts';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STRONG_PASSWORD = 'mat-khau-du-manh-12';
const TEST_USERS = { where: { email: { endsWith: TEST_EMAIL_DOMAIN } } };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('phiên đăng nhập trên Postgres thật', () => {
  let db: TestDb;
  let auth: RunningService;
  let gateway: RunningService;
  let fakeGoogle: Server;
  let baseline: unknown;
  /** Mọi bí mật đã phát ra trong test: cuối cùng kiểm tra không chuỗi nào có trong log. */
  const secrets = new Set<string>();

  const counts = async () => ({
    users: await db.user.count(),
    userBranches: await db.userBranch.count(),
    refreshTokens: await db.refreshToken.count(),
    identities: await db.authIdentity.count(),
    auditLogs: await db.auditLog.count(),
    outbox: await db.outboxEvent.count(),
  });

  const removeTestData = async () => {
    const ids = (await db.user.findMany(TEST_USERS)).map((user) => user.id);
    const byUser = { where: { userId: { in: ids } } };
    await db.refreshToken.deleteMany(byUser);
    await db.authIdentity.deleteMany(byUser);
    await db.userBranch.deleteMany(byUser);
    await db.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  };

  before(async () => {
    migrate();
    db = createDb();
    // Service auth chạy thật có job dọn outbox: không được xoá dòng thật.
    const stale = await db.outboxEvent.count({
      where: {
        status: 'PUBLISHED',
        publishedAt: { lt: new Date(Date.now() - RETENTION_MS) },
      },
    });
    if (stale > 0) {
      throw new Error(`Dừng, không chạy test: auth.OutboxEvent có ${stale} dòng job dọn sẽ xoá`);
    }
    await removeTestData(); // phần còn sót nếu lần chạy trước bị ngắt
    baseline = await counts();
    const { server, url } = await startFakeGoogle();
    fakeGoogle = server;
    auth = await startService('auth', authServiceEnv(url));
    gateway = await startService('gateway', {
      AUTH_URL: auth.url,
      INVENTORY_URL: 'http://127.0.0.1:1',
      SALES_URL: 'http://127.0.0.1:1',
      REPORT_URL: 'http://127.0.0.1:1',
    });
  });

  after(async () => {
    try {
      await stopService(gateway);
      await stopService(auth);
      fakeGoogle?.closeAllConnections();
      fakeGoogle?.close();
      await removeTestData();
      assert.deepEqual(await counts(), baseline, 'dữ liệu phải giống hệt trước khi chạy');
    } finally {
      await db?.$disconnect();
    }
  });

  afterEach(removeTestData);

  const createUser = async (
    options: { status?: string; withRole?: boolean } = {},
  ): Promise<TestUser> =>
    db.user.create({
      data: {
        email: `${randomUUID()}${TEST_EMAIL_DOMAIN}`,
        fullName: 'Người Thử',
        status: options.status ?? 'ACTIVE',
        ...(options.withRole === false ? {} : { branches: { create: { role: 'ADMIN' } } }),
      },
    });

  const credentialFor = async (email: string, subject: string = randomUUID()) => {
    const credential = await google.sign({ aud: GOOGLE_CLIENT_ID, sub: subject, email });
    secrets.add(credential);
    return credential;
  };

  const postJson = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'trinh-duyet-test' },
      body: JSON.stringify(body),
    });

  interface Session {
    accessToken: string;
    expiresIn: number;
    user: { id: string; branches: unknown[] };
  }

  const cookieOf = (response: Response): string => {
    const header = response.headers.getSetCookie().find((c) => c.startsWith('rt_bo='));
    assert.ok(header, 'phải đặt cookie rt_bo');
    const value = header.slice('rt_bo='.length, header.indexOf(';'));
    if (value !== '') {
      secrets.add(value);
    }
    return value;
  };

  /** Mặc định mỗi user một `sub` cố định, như một tài khoản Google thật. */
  const login = async (user: TestUser, subject: string = `sub-${user.id}`) => {
    const response = await postJson(auth.url, '/auth/google', {
      credential: await credentialFor(user.email, subject),
    });
    assert.equal(response.status, 200);
    const session = (await response.json()) as Session;
    secrets.add(session.accessToken);
    return { session, cookie: cookieOf(response) };
  };

  const refresh = (cookie: string) =>
    fetch(`${auth.url}/auth/refresh`, { method: 'POST', headers: { cookie: `rt_bo=${cookie}` } });

  const codeOf = async (response: Response) => ((await response.json()) as { code: string }).code;

  const tokensOf = (user: TestUser) =>
    db.refreshToken.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });

  const activeTokens = async (user: TestUser) =>
    (await tokensOf(user)).filter((token) => token.revokedAt === null);

  const shiftToken = (cookie: string, assignment: string) =>
    db.$executeRawUnsafe(
      `UPDATE "auth"."RefreshToken" SET ${assignment} WHERE "tokenHash" = $1`,
      sha256(cookie),
    );

  describe('đăng nhập Google', () => {
    it('ghép lần đầu: tạo AuthIdentity + AuditLog; lần sau tìm theo sub, không tạo thêm', async () => {
      const user = await createUser();
      const subject = randomUUID();

      const first = await login(user, subject);
      assert.equal(first.session.user.id, user.id);
      assert.equal(first.session.expiresIn, 900);
      assert.deepEqual(first.session.user.branches, [{ branchId: null, role: 'ADMIN' }]);

      const identities = await db.authIdentity.findMany({ where: { userId: user.id } });
      assert.deepEqual(
        identities.map((identity) => identity.subject),
        [subject],
      );
      const audits = await db.auditLog.findMany({ where: { entityId: user.id } });
      assert.deepEqual(
        audits.map((audit) => audit.action),
        ['auth.google_linked'],
      );
      assert.equal(audits[0]?.actorId, user.id);

      await db.user.update({ where: { id: user.id }, data: { email: `doi-${user.email}` } });
      const second = await postJson(auth.url, '/auth/google', {
        credential: await credentialFor(`email-google-da-doi${TEST_EMAIL_DOMAIN}`, subject),
      });
      assert.equal(second.status, 200, 'lần sau phải tìm theo sub, không theo email');
      assert.equal(await db.authIdentity.count({ where: { userId: user.id } }), 1);
      assert.equal(await db.auditLog.count({ where: { entityId: user.id } }), 1);
    });

    it('ghép chuẩn hoá email: Google trả chữ hoa vẫn ghép được', async () => {
      const user = await createUser();
      const response = await postJson(auth.url, '/auth/google', {
        credential: await credentialFor(user.email.toUpperCase()),
      });
      assert.equal(response.status, 200);
    });

    it('hai lần đăng nhập đầu tiên song song: 1 AuthIdentity, cả hai đều nhận token', async () => {
      for (let round = 0; round < 5; round += 1) {
        const user = await createUser();
        const subject = randomUUID();
        const credential = await credentialFor(user.email, subject);

        const responses = await Promise.all(
          Array.from({ length: 4 }, () => postJson(auth.url, '/auth/google', { credential })),
        );

        assert.deepEqual(
          responses.map((response) => response.status),
          [200, 200, 200, 200],
        );
        for (const response of responses) {
          secrets.add(((await response.json()) as Session).accessToken);
          cookieOf(response);
        }
        assert.equal(await db.authIdentity.count({ where: { userId: user.id } }), 1);
        assert.equal(await db.auditLog.count({ where: { entityId: user.id } }), 1);
        assert.equal((await activeTokens(user)).length, 4);
      }
    });

    it('email lạ, user bị khoá, không có vai trò: 403, không tạo gì', async () => {
      const locked = await createUser({ status: 'LOCKED' });
      const noRole = await createUser({ withRole: false });
      const cases = [`la-${randomUUID()}${TEST_EMAIL_DOMAIN}`, locked.email, noRole.email];
      for (const email of cases) {
        const response = await postJson(auth.url, '/auth/google', {
          credential: await credentialFor(email),
        });
        assert.equal(response.status, 403, email);
        assert.equal(await codeOf(response), 'ACCOUNT_NOT_PROVISIONED');
        assert.deepEqual(response.headers.getSetCookie(), []);
      }
      for (const user of [locked, noRole]) {
        assert.equal(await db.authIdentity.count({ where: { userId: user.id } }), 0);
        assert.equal(await db.refreshToken.count({ where: { userId: user.id } }), 0);
        assert.equal(await db.auditLog.count({ where: { entityId: user.id } }), 0);
      }
      assert.equal(await db.user.count({ where: { email: cases[0] } }), 0);
    });

    it('user đã liên kết Google khác: sub mới cùng email bị từ chối', async () => {
      const user = await createUser();
      await login(user);
      const response = await postJson(auth.url, '/auth/google', {
        credential: await credentialFor(user.email),
      });
      assert.equal(response.status, 403);
      assert.equal(await db.authIdentity.count({ where: { userId: user.id } }), 1);
    });

    it('user đã ghép rồi bị khoá: 403', async () => {
      const user = await createUser();
      const subject = randomUUID();
      await login(user, subject);
      await db.user.update({ where: { id: user.id }, data: { status: 'LOCKED' } });
      const response = await postJson(auth.url, '/auth/google', {
        credential: await credentialFor(user.email, subject),
      });
      assert.equal(response.status, 403);
    });

    it('ID token sai: 401 INVALID_CREDENTIALS; thiếu credential: 400', async () => {
      const wrong = await postJson(auth.url, '/auth/google', { credential: 'khong-hop-le' });
      assert.equal(wrong.status, 401);
      assert.equal(await codeOf(wrong), 'INVALID_CREDENTIALS');
      assert.equal((await postJson(auth.url, '/auth/google', {})).status, 400);
    });

    it('cookie đúng thuộc tính, DB chỉ lưu bản băm, ghi nhận user-agent', async () => {
      const user = await createUser();
      const response = await postJson(auth.url, '/auth/google', {
        credential: await credentialFor(user.email),
      });
      const [header] = response.headers.getSetCookie();
      assert.match(
        header ?? '',
        /^rt_bo=[\w-]+; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict; Path=\/api\/auth$/,
      );
      const cookie = cookieOf(response);
      const [token] = await tokensOf(user);
      assert.equal(token?.tokenHash, sha256(cookie));
      assert.notEqual(token?.tokenHash, cookie);
      assert.equal(token?.userAgent, 'trinh-duyet-test');
    });
  });

  describe('refresh', () => {
    it('xoay vòng: token cũ bị thay, token mới dùng được, giữ nguyên sessionStartedAt', async () => {
      const user = await createUser();
      const { cookie } = await login(user);
      const [original] = await tokensOf(user);

      const response = await refresh(cookie);
      assert.equal(response.status, 200);
      const next = cookieOf(response);
      assert.notEqual(next, cookie);
      secrets.add(((await response.json()) as Session).accessToken);

      const [old, current] = await tokensOf(user);
      assert.ok(old?.revokedAt && old.replacedAt);
      assert.equal(current?.revokedAt, null);
      assert.equal(current?.sessionStartedAt.getTime(), original?.sessionStartedAt.getTime());
      assert.ok((current?.expiresAt.getTime() ?? 0) >= (original?.expiresAt.getTime() ?? 0));

      assert.equal((await refresh(next)).status, 200);
    });

    it('đọc lại vai trò mới nhất khi refresh', async () => {
      const user = await createUser();
      const { cookie } = await login(user);
      await db.user.update({ where: { id: user.id }, data: { fullName: 'Tên Mới' } });
      const response = await refresh(cookie);
      const body = (await response.json()) as Session & { user: { fullName: string } };
      secrets.add(body.accessToken);
      cookieOf(response);
      assert.equal(body.user.fullName, 'Tên Mới');
    });

    it('không có cookie, token lạ: 401 SESSION_EXPIRED', async () => {
      const none = await fetch(`${auth.url}/auth/refresh`, { method: 'POST' });
      assert.equal(none.status, 401);
      assert.equal(await codeOf(none), 'SESSION_EXPIRED');
      assert.equal(await codeOf(await refresh('token-la')), 'SESSION_EXPIRED');
    });

    const expectExpiredWithoutRotation = async (user: TestUser, cookie: string) => {
      const response = await refresh(cookie);
      assert.equal(response.status, 401);
      assert.equal(await codeOf(response), 'SESSION_EXPIRED');
      assert.equal(cookieOf(response), '', 'phải xoá cookie');
      const [token] = await tokensOf(user);
      assert.equal(token?.replacedAt, null, 'không được đánh dấu là đã xoay vòng');
      assert.equal(await db.refreshToken.count({ where: { userId: user.id } }), 1);
    };

    it('hết hạn trượt: 401, token không bị đánh dấu xoay vòng', async () => {
      const user = await createUser();
      const { cookie } = await login(user);
      await shiftToken(cookie, `"expiresAt" = now() - interval '1 minute'`);
      await expectExpiredWithoutRotation(user, cookie);
    });

    it('hết hạn tuyệt đối: 401 dù hạn trượt còn', async () => {
      const user = await createUser();
      const { cookie } = await login(user);
      await shiftToken(cookie, `"sessionStartedAt" = now() - interval '31 days'`);
      await expectExpiredWithoutRotation(user, cookie);
    });

    it('cookie hết hạn gửi lại nhiều lần không bị coi là đánh cắp', async () => {
      const user = await createUser();
      const other = await login(user);
      const { cookie } = await login(user);
      await shiftToken(cookie, `"expiresAt" = now() - interval '1 minute'`);
      assert.equal((await refresh(cookie)).status, 401);
      await new Promise((done) => setTimeout(done, 100));
      assert.equal((await refresh(cookie)).status, 401);
      const active = await db.refreshToken.findMany({
        where: { tokenHash: sha256(other.cookie), revokedAt: null },
      });
      assert.equal(active.length, 1, 'phiên khác không được bị thu hồi');
    });

    it('user bị khoá hoặc mất vai trò: 401', async () => {
      const locked = await createUser();
      const first = await login(locked);
      await db.user.update({ where: { id: locked.id }, data: { status: 'LOCKED' } });
      assert.equal((await refresh(first.cookie)).status, 401);

      const noRole = await createUser();
      const second = await login(noRole);
      await db.userBranch.deleteMany({ where: { userId: noRole.id } });
      assert.equal((await refresh(second.cookie)).status, 401);
    });

    it('hai refresh song song cùng cookie: đúng 1 thành công, bên kia 409, không phiên nào bị thu hồi', async () => {
      for (let round = 0; round < 10; round += 1) {
        const user = await createUser();
        const other = await login(user);
        const { cookie } = await login(user);

        const responses = await Promise.all([refresh(cookie), refresh(cookie)]);

        const statuses = responses.map((response) => response.status).sort();
        assert.deepEqual(statuses, [200, 409], `vòng ${round}`);
        const winner = responses.find((response) => response.status === 200) as Response;
        const loser = responses.find((response) => response.status === 409) as Response;
        assert.equal(await codeOf(loser), 'REFRESH_CONFLICT');
        assert.deepEqual(loser.headers.getSetCookie(), [], 'bên thua không được xoá cookie');
        secrets.add(((await winner.json()) as Session).accessToken);

        const active = await activeTokens(user);
        assert.equal(active.length, 2, 'phiên kia và token mới vẫn còn');
        assert.ok(active.some((token) => token.tokenHash === sha256(other.cookie)));
        assert.ok(active.some((token) => token.tokenHash === sha256(cookieOf(winner))));
        assert.equal(
          await db.auditLog.count({
            where: { entityId: user.id, action: 'session.token_reuse_detected' },
          }),
          0,
        );
      }
    });

    it('dùng lại token cũ sau hơn 10 giây: mọi phiên bị thu hồi, ghi AuditLog', async () => {
      const user = await createUser();
      const other = await login(user);
      const { cookie } = await login(user);
      const next = cookieOf(await refresh(cookie));
      await shiftToken(
        cookie,
        `"replacedAt" = now() - interval '11 seconds', "revokedAt" = now() - interval '11 seconds'`,
      );

      const response = await refresh(cookie);

      assert.equal(response.status, 401);
      assert.equal(await codeOf(response), 'SESSION_EXPIRED');
      assert.deepEqual(await activeTokens(user), []);
      assert.equal((await refresh(next)).status, 401);
      assert.equal((await refresh(other.cookie)).status, 401);
      const audits = await db.auditLog.findMany({
        where: { entityId: user.id, action: 'session.token_reuse_detected' },
      });
      assert.equal(audits.length >= 1, true);
      const stored = JSON.stringify(audits);
      assert.ok(!stored.includes(cookie) && !stored.includes(sha256(cookie)));
    });

    it('dùng lại token vừa thay, trong 10 giây: 409, không thu hồi', async () => {
      const user = await createUser();
      const { cookie } = await login(user);
      cookieOf(await refresh(cookie));
      const response = await refresh(cookie);
      assert.equal(response.status, 409);
      assert.equal((await activeTokens(user)).length, 1);
    });

    it('refresh ngay sau khi đăng xuất ở tab khác: 401, không quét phiên ở máy khác', async () => {
      const user = await createUser();
      const other = await login(user);
      const { cookie } = await login(user);
      await fetch(`${auth.url}/auth/logout`, {
        method: 'POST',
        headers: { cookie: `rt_bo=${cookie}` },
      });
      const response = await refresh(cookie);
      assert.equal(response.status, 401);
      const active = await activeTokens(user);
      assert.deepEqual(
        active.map((token) => token.tokenHash),
        [sha256(other.cookie)],
      );
    });

    it('token đăng xuất đã lâu bị dùng lại: coi là đánh cắp', async () => {
      const user = await createUser();
      const other = await login(user);
      const { cookie } = await login(user);
      await fetch(`${auth.url}/auth/logout`, {
        method: 'POST',
        headers: { cookie: `rt_bo=${cookie}` },
      });
      await shiftToken(cookie, `"revokedAt" = now() - interval '11 seconds'`);
      assert.equal((await refresh(cookie)).status, 401);
      assert.deepEqual(await activeTokens(user), []);
      assert.equal((await refresh(other.cookie)).status, 401);
    });
  });

  describe('logout, logout-all, me', () => {
    it('logout: thu hồi token hiện tại, xoá cookie, 204', async () => {
      const user = await createUser();
      const { cookie } = await login(user);
      const response = await fetch(`${auth.url}/auth/logout`, {
        method: 'POST',
        headers: { cookie: `rt_bo=${cookie}` },
      });
      assert.equal(response.status, 204);
      assert.equal(cookieOf(response), '');
      assert.deepEqual(await activeTokens(user), []);
    });

    it('logout không có cookie vẫn 204 và xoá cookie', async () => {
      const response = await fetch(`${auth.url}/auth/logout`, { method: 'POST' });
      assert.equal(response.status, 204);
      assert.equal(cookieOf(response), '');
    });

    it('logout-all: mọi refresh token của user bị thu hồi, user khác không ảnh hưởng', async () => {
      const user = await createUser();
      const bystander = await createUser();
      const { session } = await login(user);
      await login(user);
      await login(bystander);

      const response = await fetch(`${auth.url}/auth/logout-all`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
      });

      assert.equal(response.status, 204);
      assert.equal(cookieOf(response), '');
      assert.deepEqual(await activeTokens(user), []);
      assert.equal((await activeTokens(bystander)).length, 1);
    });

    it('logout-all và me không có token: 401', async () => {
      assert.equal((await fetch(`${auth.url}/auth/me`)).status, 401);
      assert.equal((await fetch(`${auth.url}/auth/logout-all`, { method: 'POST' })).status, 401);
    });
  });

  describe('admin:create', () => {
    const email = () => `admin-${randomUUID()}${TEST_EMAIL_DOMAIN}`;

    it('tạo đúng: User + UserBranch ADMIN + AuditLog, mật khẩu đã băm, không lộ ra', async () => {
      const address = email();
      const result = adminCreate(['--email', address.toUpperCase(), '--full-name', 'Quản Trị'], {
        password: STRONG_PASSWORD,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!(result.stdout + result.stderr).includes(STRONG_PASSWORD));

      const user = await db.user.findUnique({ where: { email: address } });
      assert.ok(user, 'email phải lưu chữ thường');
      assert.match(user.passwordHash ?? '', /^\$2[aby]\$12\$/);
      assert.deepEqual(
        await db.userBranch.findMany({
          where: { userId: user.id },
          select: { branchId: true, role: true },
        }),
        [{ branchId: null, role: 'ADMIN' }],
      );
      const audits = await db.auditLog.findMany({ where: { entityId: user.id } });
      assert.deepEqual(
        audits.map((audit) => [audit.action, audit.actorId]),
        [['user.admin_created', null]],
      );
      assert.ok(!JSON.stringify(audits).includes(STRONG_PASSWORD));
    });

    it('đọc mật khẩu từ stdin', async () => {
      const address = email();
      const result = adminCreate(['--email', address, '--full-name', 'Quản Trị'], {
        stdin: `${STRONG_PASSWORD}\n`,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await db.user.count({ where: { email: address } }), 1);
    });

    it('mật khẩu yếu bị từ chối: quá ngắn, quá 72 byte, không có; không tạo gì', async () => {
      const address = email();
      for (const options of [{ password: 'ngan' }, { password: 'a'.repeat(73) }, {}]) {
        const result = adminCreate(['--email', address, '--full-name', 'A'], options);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /LỖI/);
      }
      assert.equal(await db.user.count({ where: { email: address } }), 0);
    });

    it('email trùng bị từ chối, không ghi đè', async () => {
      const address = email();
      adminCreate(['--email', address, '--full-name', 'Đầu Tiên'], { password: STRONG_PASSWORD });
      const before_ = await db.user.findUnique({ where: { email: address } });

      const result = adminCreate(['--email', address, '--full-name', 'Thứ Hai'], {
        password: `${STRONG_PASSWORD}-khac`,
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /đã tồn tại/);
      assert.deepEqual(await db.user.findUnique({ where: { email: address } }), before_);
    });

    it('không nhận mật khẩu qua tham số dòng lệnh', async () => {
      const address = email();
      const result = adminCreate(
        ['--email', address, '--full-name', 'A', '--password', STRONG_PASSWORD],
        { password: STRONG_PASSWORD },
      );
      assert.equal(result.status, 1);
      assert.equal(await db.user.count({ where: { email: address } }), 0);
    });
  });

  describe('qua gateway, bản build thật', () => {
    it('ID token giả hợp lệ → access token dùng được cho /api/auth/me; refresh, logout đi qua', async () => {
      const user = await createUser();
      const login_ = await postJson(gateway.url, '/api/auth/google', {
        credential: await credentialFor(user.email),
      });
      assert.equal(login_.status, 200);
      const session = (await login_.json()) as Session;
      secrets.add(session.accessToken);
      const cookie = cookieOf(login_);
      const [token] = await tokensOf(user);
      assert.equal(token?.ip?.endsWith('127.0.0.1'), true, 'gateway phải chuyển địa chỉ client');

      const me = await fetch(`${gateway.url}/api/auth/me`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      assert.equal(me.status, 200);
      assert.deepEqual(await me.json(), {
        id: user.id,
        email: user.email,
        fullName: 'Người Thử',
        branches: [{ branchId: null, role: 'ADMIN', branchName: null }],
        googleLinked: true,
      });

      const refreshed = await fetch(`${gateway.url}/api/auth/refresh`, {
        method: 'POST',
        headers: { cookie: `rt_bo=${cookie}` },
      });
      assert.equal(refreshed.status, 200);
      const next = cookieOf(refreshed);
      secrets.add(((await refreshed.json()) as Session).accessToken);

      const logout = await fetch(`${gateway.url}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: `rt_bo=${next}` },
      });
      assert.equal(logout.status, 204);
      assert.deepEqual(await activeTokens(user), []);
    });

    it('access token đăng nhập được ở /api/admin/*: tới auth', async () => {
      const user = await createUser();
      const { session } = await login(user);
      const response = await fetch(`${gateway.url}/api/admin/auth/khong-co`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      assert.equal(response.status, 404);
    });
  });

  it('không có token Google, refresh token hay access token nào trong log', async () => {
    assert.ok(secrets.size > 20, `chỉ thu được ${secrets.size} bí mật`);
    const logs = [...auth.output, ...gateway.output].join('');
    assert.ok(logs.includes('request completed'), 'log phải có thật');
    for (const secret of secrets) {
      assert.ok(!logs.includes(secret), 'có bí mật trong log');
    }
  });
});
