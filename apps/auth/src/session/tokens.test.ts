import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clearedRefreshCookie,
  generateRefreshToken,
  hashRefreshToken,
  readRefreshCookie,
  refreshCookie,
  refreshExpiry,
} from './tokens.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('refresh token', () => {
  it('32 byte ngẫu nhiên, mỗi lần một khác', () => {
    const token = generateRefreshToken();
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.notEqual(token, generateRefreshToken());
  });

  it('băm SHA-256, cố định theo đầu vào, không chứa token gốc', () => {
    const hash = hashRefreshToken('abc');
    assert.equal(hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(hashRefreshToken('abc'), hash);
  });
});

describe('refreshExpiry', () => {
  const start = new Date('2026-01-01T00:00:00Z');

  it('hạn trượt 7 ngày', () => {
    assert.equal(refreshExpiry(start, start).getTime(), start.getTime() + 7 * DAY);
  });

  it('không vượt hạn tuyệt đối 30 ngày', () => {
    const late = new Date(start.getTime() + 28 * DAY);
    assert.equal(refreshExpiry(start, late).getTime(), start.getTime() + 30 * DAY);
  });
});

describe('cookie', () => {
  it('đủ thuộc tính bảo mật, Path=/api/auth', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const cookie = refreshCookie('tk', new Date(now.getTime() + 60_000), now);
    assert.equal(cookie, 'rt_bo=tk; Max-Age=60; HttpOnly; Secure; SameSite=Strict; Path=/api/auth');
  });

  it('xoá cookie dùng cùng Path', () => {
    assert.equal(
      clearedRefreshCookie(),
      'rt_bo=; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Path=/api/auth',
    );
  });

  it('đọc đúng cookie trong nhiều cookie, không nhầm tên có cùng hậu tố', () => {
    assert.equal(readRefreshCookie('a=1; rt_bo=xyz; b=2'), 'xyz');
    assert.equal(readRefreshCookie('xrt_bo=sai; rt_bo=dung'), 'dung');
    assert.equal(readRefreshCookie('a=1'), undefined);
    assert.equal(readRefreshCookie('rt_bo='), undefined);
    assert.equal(readRefreshCookie(undefined), undefined);
  });
});
