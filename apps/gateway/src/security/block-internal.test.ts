import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blockInternal } from './block-internal.ts';

describe('blockInternal', () => {
  it('trả 404 cho đường /internal/*', () => {
    let status = 0;
    let body: unknown;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(payload: unknown) {
        body = payload;
        return res;
      },
    };

    blockInternal({ method: 'GET', originalUrl: '/internal/ping' }, res);

    assert.equal(status, 404);
    assert.deepEqual(body, {
      message: 'Cannot GET /internal/ping',
      error: 'Not Found',
      statusCode: 404,
    });
  });
});
