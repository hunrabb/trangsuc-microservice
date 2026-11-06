import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { BusinessError } from '@jewelry/common';
import { createGoogleIssuer, type GoogleIssuer } from '@jewelry/test-utils';
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { verifyGoogleIdToken } from './google-id-token.ts';

const CLIENT_ID = 'client-test.apps.googleusercontent.com';

const isInvalid = (error: unknown) => {
  assert.ok(error instanceof BusinessError, String(error));
  assert.equal(error.code, 'INVALID_CREDENTIALS');
  assert.equal(error.httpStatus, 401);
  return true;
};

describe('verifyGoogleIdToken', () => {
  let google: GoogleIssuer;
  const verify = (token: string) =>
    verifyGoogleIdToken(token, createLocalJWKSet(google.jwks as JSONWebKeySet), CLIENT_ID);
  const sign = (overrides: Record<string, unknown> = {}) =>
    google.sign({ aud: CLIENT_ID, sub: 'google-sub-1', email: 'A.Nguyen@Gmail.com', ...overrides });

  before(() => {
    google = createGoogleIssuer();
  });

  it('token đúng: trả sub và email chữ thường', async () => {
    assert.deepEqual(await verify(await sign()), {
      subject: 'google-sub-1',
      email: 'a.nguyen@gmail.com',
    });
  });

  it('chấp nhận cả hai giá trị iss của Google', async () => {
    assert.ok(await verify(await sign({ iss: 'accounts.google.com' })));
    assert.ok(await verify(await sign({ iss: 'https://accounts.google.com' })));
  });

  it('sai chữ ký: ký bằng khoá không có trong JWKS', async () => {
    const stranger = createGoogleIssuer();
    const token = await stranger.sign({ aud: CLIENT_ID, sub: 'x', email: 'a@gmail.com' });
    await assert.rejects(verify(token), isInvalid);
  });

  it('sai aud', async () => {
    await assert.rejects(verify(await sign({ aud: 'client-khac' })), isInvalid);
  });

  it('sai iss', async () => {
    await assert.rejects(verify(await sign({ iss: 'https://evil.example' })), isInvalid);
  });

  it('hết hạn', async () => {
    const exp = Math.floor(Date.now() / 1000) - 3600;
    await assert.rejects(verify(await sign({ exp })), isInvalid);
  });

  it('email_verified = false, hoặc không phải đúng true', async () => {
    await assert.rejects(verify(await sign({ email_verified: false })), isInvalid);
    await assert.rejects(verify(await sign({ email_verified: 'true' })), isInvalid);
    await assert.rejects(verify(await sign({ email_verified: undefined })), isInvalid);
  });

  it('thiếu sub, thiếu email', async () => {
    await assert.rejects(verify(await sign({ sub: undefined })), isInvalid);
    await assert.rejects(verify(await sign({ sub: '' })), isInvalid);
    await assert.rejects(verify(await sign({ email: undefined })), isInvalid);
  });

  it('chuỗi không phải JWT', async () => {
    await assert.rejects(verify('khong-phai-jwt'), isInvalid);
  });

  it('không lấy được khoá của Google: 503, không phải sai thông tin', async () => {
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(verifyGoogleIdToken(await sign(), down, CLIENT_ID), (error: unknown) => {
      assert.ok(error instanceof BusinessError);
      assert.equal(error.code, 'SERVICE_UNAVAILABLE');
      return true;
    });
  });
});
