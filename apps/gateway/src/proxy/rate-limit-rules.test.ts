import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLimitedByUser, rateLimitsFor } from './rate-limit-rules.ts';

const login = (email: unknown) => Buffer.from(JSON.stringify({ email, password: 'x' }));
const limits = (path: string, body?: Buffer) =>
  rateLimitsFor('POST', path, '1.2.3.4', body).map(({ key, limit }) => [key, limit]);

describe('rateLimitsFor', () => {
  it('login: 5 theo IP + email, 20 theo IP', () => {
    assert.deepEqual(limits('/auth/login', login('a@b.co')), [
      ['login:ip+email:1.2.3.4:a@b.co', 5],
      ['login:ip:1.2.3.4', 20],
    ]);
  });

  it('google 20 theo IP, refresh 60 theo IP, đều trong một phút', () => {
    assert.deepEqual(limits('/auth/google'), [['google:ip:1.2.3.4', 20]]);
    assert.deepEqual(limits('/auth/refresh'), [['refresh:ip:1.2.3.4', 60]]);
    assert.equal(rateLimitsFor('POST', '/auth/google', 'x', undefined)[0]?.ttlMs, 60_000);
  });

  it('change-password: 5 lần / 15 phút theo user, 20 lần / phút theo IP', () => {
    assert.deepEqual(rateLimitsFor('POST', '/auth/change-password', '1.2.3.4', undefined, 'u1'), [
      { key: 'change-password:user:u1', limit: 5, ttlMs: 900_000 },
      { key: 'change-password:ip:1.2.3.4', limit: 20, ttlMs: 60_000 },
    ]);
  });

  it('chỉ change-password cần biết user, và không lách được bằng cách viết đường dẫn khác', () => {
    for (const path of [
      '/auth/change-password',
      '/auth/CHANGE-password/',
      '/auth/change-password?x=1',
    ]) {
      assert.equal(isLimitedByUser('POST', path), true, path);
    }
    assert.equal(isLimitedByUser('GET', '/auth/change-password'), false);
    assert.equal(isLimitedByUser('POST', '/auth/login'), false);
  });

  it('không lách được bằng cách viết đường dẫn khác', () => {
    for (const path of [
      '/auth/LOGIN',
      '/auth/login/',
      '/auth/Login//',
      '/auth/%6Cogin',
      '/auth/login?x=1',
    ]) {
      assert.equal(limits(path).length, 2, path);
    }
  });

  it('không lách được bằng cách viết email khác', () => {
    const key = limits('/auth/login', login(' A@B.Co '))[0]?.[0];
    assert.equal(key, 'login:ip+email:1.2.3.4:a@b.co');
  });

  it('body hỏng vẫn bị giới hạn', () => {
    for (const body of [Buffer.from('{hong'), login(123), undefined]) {
      assert.equal(limits('/auth/login', body)[0]?.[0], 'login:ip+email:1.2.3.4:');
    }
  });

  it('method khác POST và đường khác không bị giới hạn', () => {
    assert.deepEqual(rateLimitsFor('GET', '/auth/login', 'x', undefined), []);
    assert.deepEqual(limits('/auth/me'), []);
  });
});
