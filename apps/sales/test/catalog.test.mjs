import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicCatalogService, isAvailable } from '../dist/catalog/catalog.service.js';
import { onProductSnapshot, onAvailability } from '../dist/catalog/catalog-events.js';
import { shopQuerySchema } from '@jewelry/contracts';
const id = '00000000-0000-4000-8000-000000000001';
const variantId = '00000000-0000-4000-8000-000000000002';
const snapshot = () => ({
  id,
  categoryId: id,
  categoryName: 'Nhẫn',
  name: 'Nhẫn vàng',
  description: null,
  imageUrl: null,
  isActive: true,
  version: 5,
  capturedAt: new Date().toISOString(),
  variants: [
    { id: variantId, sku: 'N1', name: '18K', metalKind: 'GOLD', estimatedPrice: '1000.00' },
  ],
});
test('query defaults and bounded pagination, filters and price ranges', () => {
  assert.deepEqual(shopQuerySchema.parse({}), { page: 1, pageSize: 20, sort: 'name' });
  for (const q of [
    { page: 0 },
    { page: 1.5 },
    { page: 10001 },
    { pageSize: 51 },
    { pageSize: [1, 2] },
    { categoryId: 'x' },
    { metalKind: 'IRON' },
    { sort: 'costPrice' },
    { minPrice: '-1' },
    { minPrice: '20', maxPrice: '10' },
    { search: 'x'.repeat(101) },
    { internal: 'true' },
  ])
    assert.equal(shopQuerySchema.safeParse(q).success, false, JSON.stringify(q));
  assert.equal(
    shopQuerySchema.safeParse({
      page: '2',
      pageSize: '50',
      metalKind: 'GOLD',
      minPrice: '100.00',
      maxPrice: '200.00',
      sort: 'price_desc',
    }).success,
    true,
  );
});
test('availability fails closed for missing stock, stale data or future timestamps', () => {
  assert.equal(isAvailable(1, new Date(999), 1000), true);
  assert.equal(isAvailable(0, new Date(999), 1000), false);
  assert.equal(isAvailable(1, new Date(0), 120001), false);
  assert.equal(isAvailable(1, new Date(1001), 1000), false);
});
function fixture({ active = true, version = 5, age = 0 } = {}) {
  const p = {
    ...snapshot(),
    capturedAt: new Date(),
    variants: [
      {
        ...snapshot().variants[0],
        estimatedPrice: { toFixed: () => '1000.00' },
        costPrice: 'SECRET',
      },
    ],
    internal: 'SECRET',
  };
  const tx = {
    catalogProduct: {
      findFirst: async (q) => {
        assert.equal(q.where.isActive, true);
        assert.ok(q.where.capturedAt.gte instanceof Date);
        return active ? p : null;
      },
    },
    catalogAvailability: {
      findMany: async () => [
        { variantId, available: 1, version, capturedAt: new Date(Date.now() - age) },
      ],
    },
  };
  return { tx, service: new PublicCatalogService({ $transaction: async (cb) => cb(tx) }) };
}
test('detail maps explicit public fields and rejects unpublished/not found', async () => {
  const body = await fixture().service.detail(id);
  assert.equal(body.inStock, true);
  assert.equal(body.variants[0].sku, 'N1');
  assert.equal(JSON.stringify(body).includes('SECRET'), false);
  assert.equal('version' in body, false);
  await assert.rejects(fixture({ active: false }).service.detail(id), /Không tìm thấy/);
});
test('detail with old availability or mismatched product/stock versions is not in stock', async () => {
  for (const options of [{ version: 4 }, { version: 6 }, { age: 120001 }])
    assert.equal((await fixture(options).service.detail(id)).inStock, false);
});
test('list applies publication, freshness, search and same-variant filters with parameterized pagination', async () => {
  const { tx, service } = fixture();
  let n = 0;
  tx.$queryRaw = async (sql) => {
    assert.match(sql.sql, /"isActive" = true/);
    assert.match(sql.sql, /interval '2 minutes'/);
    assert.match(sql.sql, /"metalKind" = \?/);
    assert.match(sql.sql, /"estimatedPrice" >= \?::numeric/);
    assert.match(sql.sql, /"estimatedPrice" <= \?::numeric/);
    assert.ok(sql.values.includes('%a\\%\\_%'));
    assert.ok(sql.values.includes('GOLD'));
    if (++n === 1) {
      assert.match(sql.sql, /prices.price DESC NULLS LAST, p.id ASC LIMIT \? OFFSET \?/);
      assert.deepEqual(sql.values.slice(-2), [2, 2]);
      return [{ id }];
    }
    return [{ total: 3n }];
  };
  const body = await service.list(
    shopQuerySchema.parse({
      page: 2,
      pageSize: 2,
      search: 'a%_',
      metalKind: 'GOLD',
      minPrice: '1',
      maxPrice: '2000',
      sort: 'price_desc',
    }),
  );
  assert.equal(body.total, 3);
  assert.equal(body.items.length, 1);
  assert.equal(body.page, 2);
});
test('old/duplicate product snapshots cannot replace variants; new snapshot replaces atomically', async () => {
  let replacements = 0;
  let changed = 0;
  const tx = {
    $executeRaw: async (strings) => {
      assert.match(strings.join('?'), /"version" < EXCLUDED\."version"/);
      return changed;
    },
    catalogVariant: {
      deleteMany: async () => {
        replacements++;
      },
      createMany: async () => {
        replacements++;
      },
    },
  };
  await onProductSnapshot(snapshot(), { tx });
  assert.equal(replacements, 0);
  changed = 1;
  await onProductSnapshot(snapshot(), { tx });
  assert.equal(replacements, 2);
});
test('availability consumer supports stock arriving before product and uses atomic version gate', async () => {
  let calls = 0;
  await onAvailability(
    { variantId, available: 0, version: 6, capturedAt: new Date().toISOString() },
    {
      tx: {
        $executeRaw: async (strings) => {
          calls++;
          assert.match(strings.join('?'), /"version" < EXCLUDED\."version"/);
        },
      },
    },
  );
  assert.equal(calls, 1);
});
test('malformed/sensitive snapshots fail permanently before database writes', async () => {
  await assert.rejects(
    onProductSnapshot({ ...snapshot(), costPrice: 'secret' }, { tx: {} }),
    /Invalid public/,
  );
  await assert.rejects(
    onAvailability(
      { variantId, available: -1, version: 1, capturedAt: new Date().toISOString() },
      { tx: {} },
    ),
    /Invalid public/,
  );
});

test('only public catalog controller is explicitly anonymous', async () => {
  const { PublicCatalogController } = await import('../dist/catalog/catalog.controller.js');
  assert.equal(Reflect.getMetadata('jewelry:isPublic', PublicCatalogController), true);
});
