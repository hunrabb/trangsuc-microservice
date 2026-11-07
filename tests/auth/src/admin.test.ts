// Chạy trên Postgres thật: pnpm test:auth. Mọi request đi qua gateway bản build thật, tới auth bản build thật.
// Chỉ đụng vào user thuộc TEST_EMAIL_DOMAIN và chi nhánh mã TEST_BRANCH_PREFIX; chạy xong số dòng phải y như trước.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, before, describe, it } from 'node:test';
import { signTestToken } from '@jewelry/test-utils';
import {
  authServiceEnv,
  createDb,
  GOOGLE_CLIENT_ID,
  google,
  keys,
  migrate,
  type RunningService,
  startFakeGoogle,
  startService,
  stopService,
  TEST_EMAIL_DOMAIN,
  type TestDb,
  type TestUser,
} from './support.ts';

const TEST_BRANCH_PREFIX = 'ADMTEST-';
const TEST_USERS = { where: { email: { endsWith: TEST_EMAIL_DOMAIN } } };
const TEST_BRANCHES = { where: { code: { startsWith: TEST_BRANCH_PREFIX } } };
const PASSWORD = 'mat-khau-admin-du-manh';
const FAKE_HASH = '$2a$12$abcdefghijklmnopqrstuuLm8m9x1eYQ0m1Y8t3hQ3b1o6o5Yb5nC';
const ADMIN_ROLE = { branchId: null, role: 'ADMIN' };
const CONCURRENT_ROUNDS = 10;
/** Đủ để request tới bước chờ khoá, còn dưới `lock_timeout` 3 giây của service. */
const REQUEST_REACHES_LOCK_MS = 500;

type Body = Record<string, unknown>;
interface Assignment {
  branchId: string | null;
  role: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const email = () => `${randomUUID()}${TEST_EMAIL_DOMAIN}`;

describe('quản lý chi nhánh và nhân viên', () => {
  let db: TestDb;
  let auth: RunningService;
  let gateway: RunningService;
  let fakeGoogle: Server;
  let baseline: unknown;
  let branchA: { id: string; code: string; version: number };
  let branchB: { id: string; code: string; version: number };

  const counts = async () => ({
    users: await db.user.count(),
    roles: await db.userBranch.count(),
    tokens: await db.refreshToken.count(),
    identities: await db.authIdentity.count(),
    audits: await db.auditLog.count(),
    branches: await db.branch.count(),
    outbox: await db.outboxEvent.count(),
  });

  const removeTestUsers = async () => {
    const ids = (await db.user.findMany(TEST_USERS)).map((user) => user.id);
    const byUser = { where: { userId: { in: ids } } };
    await db.refreshToken.deleteMany(byUser);
    await db.authIdentity.deleteMany(byUser);
    await db.userBranch.deleteMany(byUser);
    await db.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  };

  const removeTestBranches = async () => {
    const ids = (await db.branch.findMany(TEST_BRANCHES)).map((branch) => branch.id);
    await db.userBranch.deleteMany({ where: { branchId: { in: ids } } });
    await db.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await db.branch.deleteMany({ where: { id: { in: ids } } });
  };

  const createBranch = () =>
    db.branch.create({
      data: { code: `${TEST_BRANCH_PREFIX}${randomUUID()}`, name: 'Chi nhánh thử' },
    });

  before(async () => {
    migrate();
    db = createDb();
    await removeTestUsers();
    await removeTestBranches();
    // Quy tắc ADMIN cuối cùng đếm toàn hệ thống: ADMIN lạ làm test không còn ý nghĩa, và không được đụng vào.
    const foreignAdmins = await db.userBranch.count({
      where: { role: 'ADMIN', user: { email: { not: { endsWith: TEST_EMAIL_DOMAIN } } } },
    });
    if (foreignAdmins > 0) {
      throw new Error(`Dừng, không chạy test: auth có ${foreignAdmins} ADMIN ngoài dữ liệu test`);
    }
    baseline = await counts();
    branchA = await createBranch();
    branchB = await createBranch();
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
      await Promise.all([gateway, auth].map(stopService));
      fakeGoogle?.closeAllConnections();
      fakeGoogle?.close();
      await removeTestUsers();
      await removeTestBranches();
      assert.deepEqual(await counts(), baseline, 'dữ liệu phải giống hệt trước khi chạy');
    } finally {
      await db?.$disconnect();
    }
  });

  afterEach(removeTestUsers);

  const createUser = (
    assignments: Assignment[],
    options: { hash?: string | null; status?: string; google?: boolean } = {},
  ): Promise<TestUser> =>
    db.user.create({
      data: {
        email: email(),
        fullName: 'Người Thử',
        passwordHash: options.hash === undefined ? null : options.hash,
        status: options.status ?? 'ACTIVE',
        branches: { create: assignments },
        ...(options.google
          ? { identities: { create: { provider: 'GOOGLE', subject: randomUUID() } } }
          : {}),
      },
    });

  const createAdmin = (options: { hash?: string | null; google?: boolean } = {}) =>
    createUser([ADMIN_ROLE], { hash: FAKE_HASH, ...options });

  const manager = (branchId = branchA.id) => createUser([{ branchId, role: 'MANAGER' }]);

  const staff = (...branchIds: string[]) =>
    createUser((branchIds.length > 0 ? branchIds : [branchA.id]).map(staffAt));

  const staffAt = (branchId: string) => ({ branchId, role: 'STAFF' });

  /** Token chỉ để qua lớp xác thực: quyền đọc từ DB, nên `branches` trong token không quyết định gì. */
  const tokenOf = (user: TestUser) =>
    signTestToken(keys.privateKey, { claims: { sub: user.id, branches: [] } });

  const call = async (
    actor: TestUser,
    method: string,
    path: string,
    body?: Body,
  ): Promise<{ status: number; body: Body }> => {
    const response = await fetch(`${gateway.url}/api/admin/auth${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await tokenOf(actor)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Body) };
  };

  const assertError = (
    result: { status: number; body: Body },
    status: number,
    code: string,
  ): void => {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.code, code);
  };

  const assertFieldError = (result: { status: number; body: Body }, field: string): void => {
    assertError(result, 400, 'VALIDATION_FAILED');
    const { fields } = result.body.details as { fields: { field: string }[] };
    assert.ok(
      fields.some((item) => item.field === field),
      JSON.stringify(fields),
    );
  };

  /** Phiên có sẵn trong DB, dùng được qua `/api/auth/refresh`. Trả về cookie. */
  const openSession = async (user: TestUser): Promise<string> => {
    const raw = randomBytes(32).toString('base64url');
    await db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + 86_400_000),
        sessionStartedAt: new Date(),
      },
    });
    return raw;
  };

  const liveSessions = (user: TestUser) =>
    db.refreshToken.count({ where: { userId: user.id, revokedAt: null } });

  const refresh = (cookie: string) =>
    fetch(`${gateway.url}/api/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `rt_bo=${cookie}` },
    });

  const auditOf = async (entityId: string, action: string) => {
    const rows = await db.auditLog.findMany({ where: { entityId, action } });
    assert.equal(rows.length, 1, `phải có đúng 1 AuditLog ${action}`);
    assert.doesNotMatch(JSON.stringify(rows[0]), /\$2[aby]\$|passwordHash/);
    return rows[0] as { actorId: string; data: { before: Body | null; after: Body } };
  };

  const eventsOf = (aggregateId: string) =>
    db.outboxEvent.findMany({ where: { aggregateId }, orderBy: { createdAt: 'asc' } });

  const adminsLeft = () =>
    db.user.count({ where: { status: 'ACTIVE', branches: { some: { role: 'ADMIN' } } } });

  describe('quy tắc ADMIN cuối cùng', () => {
    it('khoá ADMIN duy nhất còn đăng nhập được: 409 LAST_ADMIN, không đổi gì', async () => {
      // Người thao tác vẫn ACTIVE nhưng không còn cách đăng nhập, nên `target` là ADMIN cuối cùng.
      const actor = await createAdmin({ hash: null });
      const target = await createAdmin();
      const cookie = await openSession(target);

      assertError(await call(actor, 'POST', `/users/${target.id}/lock`), 409, 'LAST_ADMIN');

      const after = await db.user.findUnique({ where: { id: target.id } });
      assert.equal(after?.status, 'ACTIVE');
      assert.equal(await liveSessions(target), 1);
      assert.equal(await db.auditLog.count({ where: { entityId: target.id } }), 0);
      assert.equal((await refresh(cookie)).status, 200);
    });

    it('ADMIN duy nhất tự bỏ vai trò: 409, còn nguyên vai trò và mật khẩu', async () => {
      const admin = await createAdmin();
      const result = await call(admin, 'PUT', `/users/${admin.id}/assignments`, {
        assignments: [staffAt(branchA.id)],
      });
      assertError(result, 409, 'LAST_ADMIN');
      assert.equal(await adminsLeft(), 1);
      const after = await db.user.findUnique({ where: { id: admin.id } });
      assert.equal(after?.passwordHash, FAKE_HASH);
    });

    it('gỡ Google của ADMIN không mật khẩu, không còn ADMIN nào khác: 409', async () => {
      const actor = await createAdmin({ hash: null });
      const target = await createAdmin({ hash: null, google: true });
      const result = await call(actor, 'POST', `/users/${target.id}/unlink-google`);
      assertError(result, 409, 'LAST_ADMIN');
      assert.equal(await db.authIdentity.count({ where: { userId: target.id } }), 1);
    });

    it(`hai ADMIN cùng hạ vai trò của nhau, ${CONCURRENT_ROUNDS} vòng: luôn còn đúng 1 ADMIN`, async (context) => {
      const losers: Record<string, number> = {};
      for (let round = 0; round < CONCURRENT_ROUNDS; round += 1) {
        const [first, second] = await Promise.all([createAdmin(), createAdmin()]);
        const demote = (actor: TestUser, target: TestUser) =>
          call(actor, 'PUT', `/users/${target.id}/assignments`, {
            assignments: [staffAt(branchA.id)],
          });

        const results = await Promise.all([demote(first, second), demote(second, first)]);

        const statuses = results.map((result) => result.status).toSorted();
        assert.equal(statuses[0], 200, JSON.stringify(results));
        assert.notEqual(statuses[1], 200, JSON.stringify(results));
        assert.equal(await adminsLeft(), 1, `vòng ${round}`);
        const loser = results.find((result) => result.status !== 200);
        const code = String(loser?.body.code);
        losers[code] = (losers[code] ?? 0) + 1;
        await removeTestUsers();
      }
      // 409: hai bên thật sự chồng nhau. 403: bên sau đọc người thao tác khi bên trước đã commit.
      assert.deepEqual(
        Object.keys(losers).filter((code) => !['LAST_ADMIN', 'FORBIDDEN'].includes(code)),
        [],
      );
      context.diagnostic(`bên thua: ${JSON.stringify(losers)}`);
    });
  });

  describe('chính sách MANAGER', () => {
    it('khoá STAFF chi nhánh mình: 200, ghi nhật ký', async () => {
      const actor = await manager();
      const target = await staff();
      const result = await call(actor, 'POST', `/users/${target.id}/lock`);
      assert.equal(result.status, 200);
      assert.equal(result.body.status, 'LOCKED');
      const audit = await auditOf(target.id, 'user.locked');
      assert.equal(audit.actorId, actor.id);
      assert.equal(audit.data.before?.status, 'ACTIVE');
      assert.equal(audit.data.after.status, 'LOCKED');
    });

    it('khoá MANAGER khác: 403', async () => {
      const actor = await manager();
      const target = await manager();
      assertError(await call(actor, 'POST', `/users/${target.id}/lock`), 403, 'FORBIDDEN');
    });

    it('khoá STAFF ở cả chi nhánh mình và chi nhánh khác: 403', async () => {
      const actor = await manager();
      const target = await staff(branchA.id, branchB.id);
      assertError(await call(actor, 'POST', `/users/${target.id}/lock`), 403, 'FORBIDDEN');
    });

    it('tạo user: chỉ STAFF ở chi nhánh mình', async () => {
      const actor = await manager();
      const body = (role: string, branchId: string) => ({
        email: email(),
        fullName: 'Nhân Viên Mới',
        assignments: [{ role, branchId }],
      });
      assert.equal((await call(actor, 'POST', '/users', body('STAFF', branchA.id))).status, 201);
      assertError(
        await call(actor, 'POST', '/users', body('MANAGER', branchA.id)),
        403,
        'FORBIDDEN',
      );
      assertError(await call(actor, 'POST', '/users', body('STAFF', branchB.id)), 403, 'FORBIDDEN');
    });

    it('không gán vai trò, không đặt lại mật khẩu; STAFF không gọi được API quản trị', async () => {
      const actor = await manager();
      const target = await staff();
      const assign = await call(actor, 'PUT', `/users/${target.id}/assignments`, {
        assignments: [{ role: 'MANAGER', branchId: branchA.id }],
      });
      assertError(assign, 403, 'FORBIDDEN');
      const reset = await call(actor, 'POST', `/users/${target.id}/reset-password`, {
        newPassword: PASSWORD,
      });
      assertError(reset, 403, 'FORBIDDEN');
      assertError(await call(target, 'GET', `/users/${target.id}`), 403, 'FORBIDDEN');
    });

    it('quyền đọc từ DB: người đã bị khoá mà token còn hạn không tự mở khoá được', async () => {
      const locked = await createUser([ADMIN_ROLE], { hash: FAKE_HASH, status: 'LOCKED' });
      await createAdmin();
      assertError(await call(locked, 'POST', `/users/${locked.id}/unlock`), 403, 'FORBIDDEN');
    });

    it('không ai tự khoá chính mình, kể cả ADMIN', async () => {
      const admin = await createAdmin();
      await createAdmin();
      assertError(await call(admin, 'POST', `/users/${admin.id}/lock`), 403, 'FORBIDDEN');
    });
  });

  describe('thu hồi phiên', () => {
    it('khoá user: mọi refresh token bị thu hồi', async () => {
      const admin = await createAdmin();
      const target = await staff();
      const cookies = [await openSession(target), await openSession(target)];
      assert.equal(await liveSessions(target), 2);

      assert.equal((await call(admin, 'POST', `/users/${target.id}/lock`)).status, 200);

      assert.equal(await liveSessions(target), 0);
      for (const cookie of cookies) {
        assert.equal((await refresh(cookie)).status, 401);
      }
    });

    /**
     * Ngoài danh sách của prompt, thêm vì là tình huống bảo mật: phiên mở đúng lúc user bị khoá.
     * Giữ khoá như thao tác quản trị, để request đang chạy chắc chắn rơi vào khe giữa lúc khoá và lúc commit.
     */
    const lockUserWhile = async (user: TestUser, send: () => Promise<Response>) => {
      let pending: Promise<Response> | undefined;
      await db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM "auth"."User" WHERE id = $1::uuid FOR UPDATE`,
          user.id,
        );
        pending = send();
        await sleep(REQUEST_REACHES_LOCK_MS);
        await tx.user.update({ where: { id: user.id }, data: { status: 'LOCKED' } });
        await tx.refreshToken.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
      return pending as Promise<Response>;
    };

    it('đăng nhập Google đúng lúc user bị khoá: bị từ chối, không có phiên sót', async () => {
      const subject = randomUUID();
      const user = await db.user.create({
        data: {
          email: email(),
          fullName: 'Nhân Viên',
          branches: { create: [staffAt(branchA.id)] },
          identities: { create: { provider: 'GOOGLE', subject } },
        },
      });
      const credential = await google.sign({
        aud: GOOGLE_CLIENT_ID,
        sub: subject,
        email: user.email,
      });

      const response = await lockUserWhile(user, () =>
        fetch(`${gateway.url}/api/auth/google`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ credential }),
        }),
      );

      assert.equal(response.status, 403);
      assert.equal(await liveSessions(user), 0);
    });

    it('refresh đúng lúc user bị khoá: 401, không deadlock, không có phiên sót', async () => {
      const user = await staff();
      const cookie = await openSession(user);

      const response = await lockUserWhile(user, () => refresh(cookie));

      assert.equal(response.status, 401);
      assert.equal(await liveSessions(user), 0);
    });

    it(`refresh song song với khoá user, ${CONCURRENT_ROUNDS} vòng: không phiên sót, không lỗi 5xx`, async () => {
      const admin = await createAdmin();
      const target = await staff();
      for (let round = 0; round < CONCURRENT_ROUNDS; round += 1) {
        const cookie = await openSession(target);
        const [locked, refreshed] = await Promise.all([
          call(admin, 'POST', `/users/${target.id}/lock`),
          refresh(cookie),
        ]);
        assert.equal(locked.status, 200, `vòng ${round}`);
        assert.ok(refreshed.status < 500, `vòng ${round}: refresh ${refreshed.status}`);
        assert.equal(await liveSessions(target), 0, `vòng ${round}`);
        assert.equal((await call(admin, 'POST', `/users/${target.id}/unlock`)).status, 200);
      }
    });
  });

  describe('chi nhánh ngừng hoạt động', () => {
    it('vai trò ở đó biến mất khỏi token ở lần refresh kế tiếp', async () => {
      const admin = await createAdmin();
      const closing = await createBranch();
      const user = await staff(branchA.id, closing.id);
      const cookie = await openSession(user);

      assert.equal((await call(admin, 'POST', `/branches/${closing.id}/deactivate`)).status, 200);

      const response = await refresh(cookie);
      assert.equal(response.status, 200);
      const { accessToken } = (await response.json()) as { accessToken: string };
      const claims = JSON.parse(
        Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString(),
      ) as { branches: Assignment[] };
      assert.deepEqual(claims.branches, [staffAt(branchA.id)]);
      assert.equal(await db.userBranch.count({ where: { userId: user.id } }), 2);
    });

    it('chỉ có vai trò ở chi nhánh đã ngừng: refresh trả 401', async () => {
      const admin = await createAdmin();
      const closing = await createBranch();
      const user = await staff(closing.id);
      const cookie = await openSession(user);
      assert.equal((await call(admin, 'POST', `/branches/${closing.id}/deactivate`)).status, 200);
      assert.equal((await refresh(cookie)).status, 401);
    });
  });

  describe('chi nhánh', () => {
    it('danh sách phân trang; MANAGER: 403', async () => {
      const admin = await createAdmin();
      const result = await call(admin, 'GET', '/branches?page=1&pageSize=1');
      assert.equal(result.status, 200);
      assert.equal((result.body.items as unknown[]).length, 1);
      assert.equal(result.body.pageSize, 1);
      assert.ok((result.body.total as number) >= 2);
      assertError(await call(await manager(), 'GET', '/branches'), 403, 'FORBIDDEN');
    });

    it('tạo: phát branch.created cùng AuditLog; trùng code: 400, không phát gì', async () => {
      const admin = await createAdmin();
      const body = { code: `${TEST_BRANCH_PREFIX}${randomUUID()}`, name: 'Mới' };
      const created = await call(admin, 'POST', '/branches', body);
      assert.equal(created.status, 201);
      const id = created.body.id as string;
      const events = await eventsOf(id);
      assert.deepEqual(
        events.map((event) => event.eventType),
        ['branch.created'],
      );
      assert.deepEqual(events[0]?.payload, { branchId: id, code: body.code, name: body.name });
      assert.equal((await auditOf(id, 'branch.created')).data.before, null);

      assertFieldError(await call(admin, 'POST', '/branches', body), 'code');
      assert.equal(await db.branch.count({ where: { code: body.code } }), 1);
      assert.equal((await eventsOf(id)).length, 1);
    });

    it('sửa: phát branch.updated; sai version: 409', async () => {
      const admin = await createAdmin();
      const branch = await createBranch();
      const path = `/branches/${branch.id}`;
      const updated = await call(admin, 'PATCH', path, {
        version: branch.version,
        name: 'Tên mới',
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.version, branch.version + 1);
      const events = await eventsOf(branch.id);
      assert.equal(events[0]?.eventType, 'branch.updated');
      assert.deepEqual(events[0]?.payload, {
        branchId: branch.id,
        code: branch.code,
        name: 'Tên mới',
        isActive: true,
      });
      await auditOf(branch.id, 'branch.updated');

      const stale = await call(admin, 'PATCH', path, { version: branch.version, name: 'Cũ' });
      assertError(stale, 409, 'VERSION_CONFLICT');
    });

    it('ngừng hoạt động: phát branch.updated có isActive = false; gọi lại: 409', async () => {
      const admin = await createAdmin();
      const branch = await createBranch();
      const path = `/branches/${branch.id}/deactivate`;
      assert.equal((await call(admin, 'POST', path)).body.isActive, false);
      const [event] = await eventsOf(branch.id);
      assert.equal(event?.eventType, 'branch.updated');
      assert.equal((event?.payload as { isActive: boolean }).isActive, false);
      await auditOf(branch.id, 'branch.deactivated');
      assertError(await call(admin, 'POST', path), 409, 'INVALID_STATE');
    });
  });

  describe('nhân viên', () => {
    it('danh sách lọc theo chi nhánh; MANAGER thiếu branchId: 403', async () => {
      const actor = await manager();
      const member = await staff();
      await staff(branchB.id);
      const result = await call(actor, 'GET', `/users?branchId=${branchA.id}&pageSize=10`);
      assert.equal(result.status, 200);
      const ids = (result.body.items as { id: string }[]).map((item) => item.id);
      assert.deepEqual(ids.toSorted(), [actor.id, member.id].toSorted());
      assert.equal(result.body.total, 2);
      assertError(await call(actor, 'GET', '/users'), 403, 'FORBIDDEN');
    });

    it('tạo: email lưu chữ thường, không trả hash; trùng email: 400', async () => {
      const admin = await createAdmin();
      const address = email();
      const body = {
        email: address.toUpperCase().replace(TEST_EMAIL_DOMAIN.toUpperCase(), TEST_EMAIL_DOMAIN),
        fullName: 'Nhân Viên',
        assignments: [staffAt(branchA.id)],
      };
      const created = await call(admin, 'POST', '/users', body);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.email, address);
      assert.equal('passwordHash' in created.body, false);
      await auditOf(created.body.id as string, 'user.created');
      assertFieldError(await call(admin, 'POST', '/users', body), 'email');
    });

    it('tạo ADMIN: thiếu mật khẩu 400; mật khẩu yếu 400; đủ thì có hash', async () => {
      const admin = await createAdmin();
      const body = { email: email(), fullName: 'Quản Trị', assignments: [ADMIN_ROLE] };
      assertFieldError(await call(admin, 'POST', '/users', body), 'password');
      assertError(
        await call(admin, 'POST', '/users', { ...body, password: 'ngan' }),
        400,
        'PASSWORD_TOO_WEAK',
      );
      const created = await call(admin, 'POST', '/users', { ...body, password: PASSWORD });
      assert.equal(created.status, 201);
      const row = await db.user.findUnique({ where: { id: created.body.id } });
      assert.ok(row?.passwordHash);
    });

    it('xem: MANAGER xem STAFF của mình; không có user: 404', async () => {
      const actor = await manager();
      const target = await staff();
      const result = await call(actor, 'GET', `/users/${target.id}`);
      assert.equal(result.status, 200);
      assert.equal(result.body.id, target.id);
      assertError(await call(actor, 'GET', `/users/${randomUUID()}`), 404, 'NOT_FOUND');
    });

    it('sửa: tăng version, ghi before/after; sai version: 409', async () => {
      const admin = await createAdmin();
      const target = await staff();
      const path = `/users/${target.id}`;
      const updated = await call(admin, 'PATCH', path, { version: 1, phone: '0900000000' });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.version, 2);
      const audit = await auditOf(target.id, 'user.updated');
      assert.equal(audit.data.before?.phone, null);
      assert.equal(audit.data.after.phone, '0900000000');
      const stale = await call(admin, 'PATCH', path, { version: 1, phone: '0911111111' });
      assertError(stale, 409, 'VERSION_CONFLICT');
    });

    it('mở khoá: 200; chưa khoá: 409', async () => {
      const admin = await createAdmin();
      const target = await createUser([staffAt(branchA.id)], { status: 'LOCKED' });
      const path = `/users/${target.id}/unlock`;
      assert.equal((await call(admin, 'POST', path)).body.status, 'ACTIVE');
      await auditOf(target.id, 'user.unlocked');
      assertError(await call(admin, 'POST', path), 409, 'INVALID_STATE');
    });

    it('gỡ Google: thu hồi mọi phiên; chưa liên kết: 409', async () => {
      const admin = await createAdmin();
      const target = await createUser([staffAt(branchA.id)], { google: true });
      await openSession(target);
      const path = `/users/${target.id}/unlink-google`;
      const result = await call(admin, 'POST', path);
      assert.equal(result.status, 200);
      assert.equal(result.body.googleLinked, false);
      assert.equal(await liveSessions(target), 0);
      await auditOf(target.id, 'user.google_unlinked');
      assertError(await call(admin, 'POST', path), 409, 'INVALID_STATE');
    });

    it('đặt lại mật khẩu: thu hồi mọi phiên, nhật ký không có hash; user không phải ADMIN: 409', async () => {
      const admin = await createAdmin();
      const target = await createAdmin();
      await openSession(target);
      const path = `/users/${target.id}/reset-password`;
      const result = await call(admin, 'POST', path, { newPassword: PASSWORD });
      assert.equal(result.status, 204);
      const row = await db.user.findUnique({ where: { id: target.id } });
      assert.notEqual(row?.passwordHash, FAKE_HASH);
      assert.equal(await liveSessions(target), 0);
      await auditOf(target.id, 'user.password_reset');

      const other = await staff();
      assertError(
        await call(admin, 'POST', `/users/${other.id}/reset-password`, { newPassword: PASSWORD }),
        409,
        'INVALID_STATE',
      );
    });

    it('gán vai trò: thêm ADMIN phải kèm mật khẩu; bỏ ADMIN xoá hash và thu hồi phiên', async () => {
      const admin = await createAdmin();
      const target = await staff();
      const path = `/users/${target.id}/assignments`;
      assertFieldError(await call(admin, 'PUT', path, { assignments: [ADMIN_ROLE] }), 'password');

      const promoted = await call(admin, 'PUT', path, {
        assignments: [ADMIN_ROLE],
        password: PASSWORD,
      });
      assert.equal(promoted.status, 200);
      assert.deepEqual(promoted.body.branches, [ADMIN_ROLE]);
      assert.ok((await db.user.findUnique({ where: { id: target.id } }))?.passwordHash);
      await openSession(target);

      const demoted = await call(admin, 'PUT', path, { assignments: [staffAt(branchB.id)] });
      assert.equal(demoted.status, 200);
      const row = await db.user.findUnique({ where: { id: target.id } });
      assert.equal(row?.passwordHash, null);
      assert.equal(await liveSessions(target), 0);
    });

    it('thêm vai trò không bớt gì: giữ phiên', async () => {
      const admin = await createAdmin();
      const target = await staff();
      await openSession(target);
      const result = await call(admin, 'PUT', `/users/${target.id}/assignments`, {
        assignments: [staffAt(branchA.id), staffAt(branchB.id)],
      });
      assert.equal(result.status, 200);
      assert.equal(await liveSessions(target), 1);
    });
  });
});
