import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnv as parse } from '@jewelry/common';
import { envSchema } from './env.ts';

const parseEnv = (raw: Record<string, unknown>) => parse(envSchema, raw);

const valid = {
  PORT: '3000',
  AUTH_URL: 'http://auth:3000',
  INVENTORY_URL: 'http://inventory:3000',
  SALES_URL: 'http://sales:3000',
  REPORT_URL: 'http://report:3000',
  JWT_PUBLIC_KEYS_DIR: '/run/secrets/jwt-public',
  JWT_ISSUER: 'auth-service',
  JWT_AUDIENCE: 'store-system',
};

describe('parseEnv (gateway)', () => {
  it('chấp nhận cấu hình hợp lệ và đổi PORT sang số', () => {
    const result = parseEnv(valid);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.env.PORT, 3000);
      assert.equal(result.env.NODE_ENV, 'development');
    }
  });

  it('báo đúng tên biến bị thiếu', () => {
    const result = parseEnv({});
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.problems.map((p) => p.variable).sort(), [
        'AUTH_URL',
        'INVENTORY_URL',
        'JWT_AUDIENCE',
        'JWT_ISSUER',
        'JWT_PUBLIC_KEYS_DIR',
        'PORT',
        'REPORT_URL',
        'SALES_URL',
      ]);
    }
  });

  it('từ chối INVENTORY_URL không phải http(s)', () => {
    assert.equal(parseEnv({ ...valid, INVENTORY_URL: 'inventory:3000' }).ok, false);
    assert.equal(parseEnv({ ...valid, INVENTORY_URL: 'ftp://inventory' }).ok, false);
  });

  it('từ chối PORT không phải số', () => {
    assert.equal(parseEnv({ ...valid, PORT: 'abc' }).ok, false);
  });
});
