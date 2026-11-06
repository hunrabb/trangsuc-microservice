import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

describe('docs/api/auth.openapi.yaml', () => {
  it('phần schemas khớp đúng bản sinh từ zod', () => {
    const result = spawnSync(
      process.execPath,
      [resolve('../../scripts/openapi-generate.mjs'), '--check'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  });
});
