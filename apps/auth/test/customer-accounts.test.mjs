import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const TEST_ISSUER = 'customer-tests';
const TEST_AUDIENCE_SHOP = 'shop-tests';
const TEST_AUDIENCE_BACKOFFICE = 'staff-tests';
function createTestKeyFiles() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'customer-account-test-'));
  const privateKeyPath = join(dir, 'private.pem'),
    publicKeyPath = join(dir, 'public.pem');
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  return { privateKeyPath, publicKeyPath };
}

import { JwtGuard, loadPublicKey } from '@jewelry/common';
import { CustomerAuthController } from '../dist/session/customer-auth.controller.js';
import { AccessTokenService } from '../dist/session/access-token.service.js';
import { MyOrdersController } from '../../sales/dist/online/my-orders.controller.js';
import { customerRegisterSchema, customerLoginSchema } from '@jewelry/contracts';

function fixture() {
  const accounts = new Map(),
    sessions = new Map();
  const prisma = {
    customerAccount: {
      createMany: async ({ data }) => {
        if ([...accounts.values()].some((a) => a.email === data[0].email)) return { count: 0 };
        accounts.set(data[0].id, data[0]);
        return { count: 1 };
      },
      findUnique: async ({ where }) =>
        [...accounts.values()].find((a) => a.email === where.email || a.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }) => {
        const a = [...accounts.values()].find((a) => a.email === where.email);
        assert.ok(a);
        return a;
      },
    },
    customerSession: {
      create: async ({ data }) => {
        sessions.set(data.id, { revokedAt: null, ...data });
        return data;
      },
      findUnique: async ({ where }) => {
        const s = [...sessions.values()].find((s) => s.tokenHash === where.tokenHash);
        return s ? { ...s, account: accounts.get(s.accountId) } : null;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const s of sessions.values())
          if (
            (!where.id || s.id === where.id) &&
            (!where.tokenHash || s.tokenHash === where.tokenHash) &&
            !s.revokedAt &&
            (!where.expiresAt || s.expiresAt > where.expiresAt.gt)
          ) {
            Object.assign(s, data);
            count++;
          }
        return { count };
      },
    },
  };
  const keys = createTestKeyFiles();
  const config = {
    get: (name) =>
      ({
        JWT_PRIVATE_KEY_PATH: keys.privateKeyPath,
        JWT_PUBLIC_KEY_PATH: keys.publicKeyPath,
        JWT_ISSUER: TEST_ISSUER,
        JWT_AUDIENCE_SHOP: TEST_AUDIENCE_SHOP,
        JWT_AUDIENCE_BACKOFFICE: TEST_AUDIENCE_BACKOFFICE,
      })[name],
  };
  const tokens = new AccessTokenService(config);
  tokens.onModuleInit();
  const guard = new JwtGuard(new Reflector(), {
    publicKey: loadPublicKey(keys.publicKeyPath),
    issuer: TEST_ISSUER,
    audiences: { shop: TEST_AUDIENCE_SHOP, backoffice: TEST_AUDIENCE_BACKOFFICE },
  });
  const controller = new CustomerAuthController(prisma, tokens);
  let cookie = '';
  const response = {
    setHeader: (key, value) => {
      assert.equal(key, 'set-cookie');
      cookie = value;
    },
  };
  return {
    controller,
    tokens,
    guard,
    accounts,
    sessions,
    response,
    request: () => ({ headers: { cookie: cookie.split(';')[0] } }),
    cookie: () => cookie,
  };
}

test('customer registration is explicit, password validated, no customerId or role accepted', () => {
  assert.equal(
    customerRegisterSchema.safeParse({ email: 'a@example.com', fullName: 'A', password: 'short' })
      .success,
    false,
  );
  assert.equal(
    customerRegisterSchema.safeParse({
      email: 'a@example.com',
      fullName: 'A',
      password: 'a'.repeat(12),
      role: 'ADMIN',
    }).success,
    false,
  );
  assert.equal(
    customerLoginSchema.safeParse({
      email: 'a@example.com',
      password: 'a',
      customerId: randomUUID(),
    }).success,
    false,
  );
  assert.equal(
    customerLoginSchema.parse({ email: 'A@example.com', password: 'a' }).email,
    'a@example.com',
  );
});

test('customer auth uses separate cookie and shop JWT; refresh rotates, replay and logout are rejected', async () => {
  const f = fixture();
  const user = { email: 'customer@example.com', fullName: 'Khách', password: 'long-password-123' };
  const session = await f.controller.register(user, f.response);
  assert.equal(f.accounts.size, 1);
  assert.ok(!JSON.stringify(session).includes('passwordHash'));
  assert.match(f.cookie(), /^rt_shop=/);
  assert.ok(f.cookie().includes('HttpOnly; Secure; SameSite=Strict; Path=/api/shop/auth'));
  const verified = await f.guard.authenticate(
    { headers: { authorization: `Bearer ${session.accessToken}` } },
    'shop',
  );
  assert.equal(verified.id, session.user.id);
  assert.deepEqual(verified.branches, []);
  await assert.rejects(
    f.guard.authenticate(
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      'backoffice',
    ),
    (e) => e.httpStatus === 401,
  );
  const before = f.request();
  const rotated = await f.controller.refresh(before, f.response);
  assert.equal(rotated.user.id, session.user.id);
  await assert.rejects(f.controller.refresh(before, f.response), (e) => e.httpStatus === 409);
  // A fresh login supplies a usable refresh credential after rejecting the replay.
  await f.controller.login({ email: user.email, password: user.password }, f.response);
  const current = f.request();
  await f.controller.logout(current, f.response);
  await assert.rejects(f.controller.refresh(current, f.response), (e) => e.httpStatus === 409);
  await assert.rejects(
    f.controller.login({ email: user.email, password: 'wrong' }, f.response),
    (e) => e.httpStatus === 401,
  );
  await assert.rejects(
    f.controller.login({ email: 'missing@example.com', password: 'wrong' }, f.response),
    (e) => e.httpStatus === 401,
  );
  assert.equal(f.accounts.size, 1);
});

test('Sales personal order handlers enforce JWT directly, reject anonymous and employee audience, use verified identity', async () => {
  const f = fixture();
  const a = randomUUID();
  const token = await f.tokens.sign(a, [], 'shop');
  for (const method of ['list', 'get', 'create', 'cancel']) {
    const request = { headers: {} };
    const context = {
      getHandler: () => MyOrdersController.prototype[method],
      getClass: () => MyOrdersController,
      switchToHttp: () => ({ getRequest: () => request }),
    };
    await assert.rejects(f.guard.canActivate(context), (e) => e.httpStatus === 401);
    request.headers.authorization = `Bearer ${await f.tokens.sign(randomUUID(), [{ branchId: null, role: 'ADMIN' }])}`;
    await assert.rejects(f.guard.canActivate(context), (e) => e.httpStatus === 401);
    request.headers.authorization = `Bearer ${token}`;
    await f.guard.canActivate(context);
    assert.equal(request.user.id, a);
  }
  const calls = [];
  const controller = new MyOrdersController({
    forAccount: (...args) => calls.push(args),
    accountOrder: (...args) => calls.push(args),
  });
  controller.list({ id: a, branches: [] }, { page: 2, pageSize: 10 });
  controller.get({ id: a, branches: [] }, 'order');
  assert.deepEqual(calls, [
    [a, 2, 10],
    [a, 'order'],
  ]);
});
