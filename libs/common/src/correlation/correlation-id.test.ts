import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLS_ID, ClsServiceManager } from 'nestjs-cls';
import {
  CORRELATION_ID_HEADER,
  correlationHeaders,
  getCorrelationId,
  resolveCorrelationId,
} from './correlation-id.ts';

const UUID = '3f2b8c1e-5a4d-4f6b-9c7e-1d2e3f4a5b6c';

describe('resolveCorrelationId', () => {
  it('nhận nguyên UUID hợp lệ từ header', () => {
    assert.equal(resolveCorrelationId(UUID), UUID);
    assert.equal(resolveCorrelationId(UUID.toUpperCase()), UUID.toUpperCase());
  });

  it('sinh mã mới khi không có header', () => {
    const id = resolveCorrelationId(undefined);
    assert.notEqual(id, resolveCorrelationId(undefined));
    assert.equal(resolveCorrelationId(id), id);
  });

  it('sinh mã mới khi header không phải một UUID', () => {
    for (const bad of ['abc', '', `${UUID}\nx`, `${UUID}, ${UUID}`, [UUID, UUID]]) {
      const id = resolveCorrelationId(bad);
      assert.notEqual(id, bad);
      assert.equal(resolveCorrelationId(id), id);
    }
  });
});

describe('getCorrelationId', () => {
  it('ở ngoài request thì không có mã và không có header', () => {
    assert.equal(getCorrelationId(), undefined);
    assert.deepEqual(correlationHeaders(), {});
  });

  it('đọc được ở mọi chỗ trong ngữ cảnh request, kể cả sau await', async () => {
    const cls = ClsServiceManager.getClsService();
    await cls.run(async () => {
      cls.set(CLS_ID, UUID);
      await Promise.resolve();
      assert.equal(getCorrelationId(), UUID);
      assert.deepEqual(correlationHeaders(), { [CORRELATION_ID_HEADER]: UUID });
    });
  });
});
