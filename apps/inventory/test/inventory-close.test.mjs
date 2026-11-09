import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const { closeDate } = require('../dist/stock/inventory-close.worker.js');

it('chỉ chốt ngày trước trong khung 00:05–00:59 giờ Việt Nam', () => {
  assert.equal(closeDate(new Date('2026-11-07T17:04:59Z')), null);
  assert.equal(closeDate(new Date('2026-11-07T17:05:00Z')), '2026-11-07');
  assert.equal(closeDate(new Date('2026-11-07T17:59:59Z')), '2026-11-07');
  assert.equal(closeDate(new Date('2026-11-07T18:00:00Z')), null);
  assert.equal(closeDate(new Date('2025-12-31T17:05:00Z')), '2025-12-31');
});
