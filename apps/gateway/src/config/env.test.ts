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
  JWT_PUBLIC_KEY_PATH: '/run/secrets/jwt-public.pem',
  JWT_ISSUER: 'auth-service',
  JWT_AUDIENCE_BACKOFFICE: 'store-backoffice',
  JWT_AUDIENCE_SHOP: 'store-shop',
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
        'JWT_AUDIENCE_BACKOFFICE',
        'JWT_AUDIENCE_SHOP',
        'JWT_ISSUER',
        'JWT_PUBLIC_KEY_PATH',
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

  it('TRUSTED_PROXIES có mặc định, nhận IP và CIDR, từ chối giá trị sai', () => {
    const standard = parseEnv(valid);
    assert.ok(standard.ok);
    assert.equal(standard.env.TRUSTED_PROXIES, '172.30.0.16/31');
    assert.equal(
      parseEnv({ ...valid, TRUSTED_PROXIES: '10.0.0.1, 192.168.0.0/16, fd00::/8' }).ok,
      true,
    );
    assert.equal(parseEnv({ ...valid, TRUSTED_PROXIES: '' }).ok, true);
    for (const value of ['khong-phai-ip', '10.0.0.0/33', '10.0.0.1/abc']) {
      assert.equal(parseEnv({ ...valid, TRUSTED_PROXIES: value }).ok, false, value);
    }
  });

  it('từ chối PORT không phải số', () => {
    assert.equal(parseEnv({ ...valid, PORT: 'abc' }).ok, false);
  });
});
