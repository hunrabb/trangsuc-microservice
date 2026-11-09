import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRoute } from './routes.ts';

test('buyback endpoints use existing backoffice Sales routing, never a public/admin alias', () => {
  for (const suffix of ['', '/by-key', '/i', '/i/submit', '/i/cancel']) {
    const path = `/branches/b/buybacks${suffix}`;
    assert.deepEqual(resolveRoute(`/api/admin/sales${path}`), {
      service: 'sales',
      path: `/admin${path}`,
      audience: 'backoffice',
    });
    assert.equal(resolveRoute(`/api/shop${path}`)?.path, `/shop${path}`);
  }
  for (const path of [
    '/internal/buybacks',
    '/api/admin/sales/internal/buybacks',
    '/api/admin/sales/%69nternal/buybacks',
    '/api/admin/sales/../internal/buybacks',
    '/api/shop/../admin/branches/b/buybacks',
    '/api/admin/sales/health/ready',
  ]) {
    assert.equal(resolveRoute(path), undefined, path);
  }
});
