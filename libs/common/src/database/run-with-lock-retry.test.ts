import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BusinessError } from '../errors/business-error';
import { runWithLockRetry } from './run-with-lock-retry';

const deadlock = () =>
  Object.assign(new Error('deadlock'), {
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode: '40P01' } } },
  });

describe('runWithLockRetry', () => {
  it('deadlock: chạy lại, lần sau thành công thì trả kết quả', async () => {
    let calls = 0;
    const result = await runWithLockRetry(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(deadlock()) : Promise.resolve('ok');
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });

  it('deadlock cả 3 lần: 503; lỗi khác không chạy lại', async () => {
    let calls = 0;
    await assert.rejects(
      runWithLockRetry(() => {
        calls += 1;
        return Promise.reject(deadlock());
      }),
      (error: BusinessError) => error.code === 'SERVICE_UNAVAILABLE',
    );
    assert.equal(calls, 3);

    let otherCalls = 0;
    await assert.rejects(
      runWithLockRetry(() => {
        otherCalls += 1;
        return Promise.reject(new Error('lỗi khác'));
      }),
      /lỗi khác/,
    );
    assert.equal(otherCalls, 1);
  });
});
