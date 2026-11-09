// Task 6.5A only: no server, database, broker or browser connections.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const contracts = require('../../libs/contracts/dist/index.js');
// Reuse the YAML parser already supplied by the repository's OpenAPI validator.
const validatorRequire = createRequire(require.resolve('@seriousme/openapi-schema-validator'));
const { parse } = validatorRequire('yaml');
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const specs = Object.fromEntries(
  ['shop', 'inventory', 'sales'].map((name) => [
    name,
    parse(read(`docs/api/${name}.openapi.yaml`)),
  ]),
);
registerHooks({
  load(url, context, next) {
    if (!url.includes('/storefront/src/') || !url.endsWith('.ts')) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
  },
});
const { resolveRoute } = await import('../../apps/gateway/src/proxy/routes.ts');
const { rateLimitsFor } = await import('../../apps/gateway/src/proxy/rate-limit-rules.ts');
const { createShopApi } = await import('../../apps/storefront/src/api/shop.ts');
const uuid = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const at = '2026-11-09T00:00:00.000Z';
const product = {
  id: uuid,
  categoryId: second,
  categoryName: 'Test',
  name: 'Test',
  description: null,
  imageUrl: null,
  capturedAt: at,
  variants: [
    {
      id: second,
      sku: 'TEST',
      name: 'Test',
      metalKind: 'GOLD',
      estimatedPrice: '1000.00',
      inStock: true,
    },
  ],
  inStock: true,
};
const order = {
  id: uuid,
  code: 'WEB-TEST',
  status: 'PENDING',
  total: null,
  expiresAt: null,
  needsReview: false,
  failureCode: null,
  items: [],
};
const canonicalPath = (value) => value.replace(/\{[^}]+\}|:[^/]+/g, ':param').replace(/\/$/, '');
function decorators(node) {
  return (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [])
    .map((d) => d.expression)
    .filter(ts.isCallExpression)
    .map((d) => ({
      name: d.expression.getText(),
      args: d.arguments.map((a) => (ts.isStringLiteral(a) ? a.text : a.getText())),
    }));
}
test('6.5A OpenAPI components match current shared contract exports for Phase 6 APIs', () => {
  for (const name of ['shop', 'inventory', 'sales'])
    assert.deepEqual(specs[name].components.schemas, contracts[`${name}OpenApiSchemas`](), name);
});
test('6.5A controller methods, Gateway rewrites and OpenAPI security agree', () => {
  const inputs = [
    ['apps/sales/src/catalog/catalog.controller.ts', 'shop', '/api', true, undefined],
    ['apps/sales/src/online/online-orders.controller.ts', 'shop', '/api', true, undefined],
    [
      'apps/sales/src/payments/online-payments.controller.ts',
      'sales',
      '/api/admin/sales',
      false,
      ['ADMIN', 'MANAGER'],
    ],
    [
      'apps/inventory/src/catalog/online-config.controller.ts',
      'inventory',
      '/api/admin/inventory',
      false,
      ['ADMIN'],
    ],
  ];
  let checked = 0;
  for (const [file, spec, prefix, isPublic, roles] of inputs) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const controller = source.statements.find(
      (n) => ts.isClassDeclaration(n) && decorators(n).some((d) => d.name === 'Controller'),
    );
    assert.ok(controller, file);
    const metadata = decorators(controller);
    const root = metadata.find((d) => d.name === 'Controller').args[0];
    assert.equal(
      metadata.some((d) => d.name === 'Public'),
      isPublic,
      file,
    );
    if (roles) assert.deepEqual(metadata.find((d) => d.name === 'Roles').args, roles);
    for (const member of controller.members) {
      const meta = decorators(member);
      const verb = meta.find((d) => ['Get', 'Post', 'Put'].includes(d.name));
      if (!verb) continue;
      const servicePath = `/${root}/${verb.args[0] ?? ''}`.replace(/\/$/, '');
      const gatewayPath =
        prefix === '/api' ? `/api${servicePath}` : `${prefix}${servicePath.slice('/admin'.length)}`;
      const path = Object.keys(specs[spec].paths).find(
        (p) => canonicalPath(p) === canonicalPath(gatewayPath),
      );
      assert.ok(path, gatewayPath);
      const op = specs[spec].paths[path][verb.name.toLowerCase()];
      assert.ok(op, `${verb.name} ${path}`);
      const resolved = resolveRoute(gatewayPath.replace(/:[^/]+/g, uuid));
      assert.ok(resolved, gatewayPath);
      assert.equal(resolved.path, servicePath.replace(/:[^/]+/g, uuid));
      assert.equal(resolved.audience, isPublic ? null : 'backoffice');
      const security = op.security ?? specs[spec].security;
      assert.deepEqual(
        security,
        root === 'shop/orders' ? [{ checkoutAccess: [] }] : isPublic ? [] : [{ bearerAuth: [] }],
      );
      if (root === 'shop/orders')
        assert.ok(
          meta.some(
            (d) => d.name === 'Header' && d.args[0] === 'Cache-Control' && d.args[1] === 'no-store',
          ),
        );
      checked++;
    }
  }
  assert.equal(checked, 11);
});
test('6.5A Storefront API method/path/header/body agrees with actual Gateway and Shop OpenAPI', async () => {
  const calls = [];
  const token = 'ab'.repeat(32),
    key = 'phase6-contract';
  const api = createShopApi(async (url, options) => {
    const path = url.split('?')[0],
      method = options.method.toLowerCase();
    const specPath = Object.keys(specs.shop.paths).find((p) =>
      new RegExp('^' + p.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(path),
    );
    assert.ok(specPath, path);
    const op = specs.shop.paths[specPath][method];
    assert.ok(op, `${method} ${path}`);
    assert.equal(resolveRoute(url).service, 'sales');
    assert.equal(resolveRoute(url).audience, null);
    if (path.startsWith('/api/shop/orders')) {
      assert.equal(options.headers.Authorization, `Checkout ${token}`);
      assert.ok(!url.includes(token));
    }
    if (path === '/api/shop/orders' || path.endsWith('/by-key'))
      assert.equal(options.headers['Idempotency-Key'], key);
    if (method === 'post' && path === '/api/shop/orders')
      contracts.createOnlineOrderSchema.parse(JSON.parse(options.body));
    calls.push(`${method} ${specPath}`);
    const result =
      path === '/api/shop/products'
        ? { items: [product], page: 1, pageSize: 12, total: 1 }
        : path.includes('/products/')
          ? product
          : order;
    return new Response(JSON.stringify(result), {
      status: method === 'post' && path === '/api/shop/orders' ? 202 : 200,
    });
  });
  await api.list(contracts.shopQuerySchema.parse({ pageSize: 12 }));
  await api.product(uuid);
  await api.create(
    {
      items: [{ variantId: second, quantity: 1 }],
      recipientName: 'Test',
      recipientPhone: '0901234567',
      shippingAddress: 'Test address 123',
    },
    token,
    key,
  );
  await api.byKey(token, key);
  await api.order(uuid, token);
  await api.cancel(uuid, token);
  assert.equal(new Set(calls).size, 6);
});
test('6.5A internal traversal is blocked while public capability and private admin routing stay separate', () => {
  for (const path of [
    '/api/shop/internal/stock',
    '/api/shop/%69nternal/stock',
    '/api/shop/../admin',
    '/api/shop/%2e%2e/internal',
    '/api/shop/orders/%2fadmin',
    '/internal/stock',
    '/api/admin/sales/internal/payments',
  ])
    assert.equal(resolveRoute(path), undefined, path);
  assert.equal(resolveRoute('/api/shop/orders/by-key').audience, null);
  assert.equal(
    resolveRoute(`/api/admin/sales/branches/${uuid}/online-orders/${second}/payments/confirm`)
      .audience,
    'backoffice',
  );
  for (const [method, path, limit] of [
    ['GET', '/shop/%70roducts/?page=1', 120],
    ['HEAD', '/shop/ORDERS/by-key/', 120],
    ['POST', '/shop/orders/', 10],
    ['POST', `/admin/branches/${uuid}/online-orders/${second}/payments/confirm`, 20],
  ])
    assert.equal(rateLimitsFor(method, path, '127.0.0.1', undefined)[0].limit, limit);
});
test('6.5A catalog and online saga messages fit shared schemas and do not accept internal fields', () => {
  const fixtures = {
    'product.snapshot': { ...product, isActive: true, version: 1 },
    'stock.availability_changed': { variantId: second, available: 1, version: 1, capturedAt: at },
    'order.created': {
      channel: 'WEBSITE',
      orderId: uuid,
      requestHash: 'a'.repeat(64),
      items: [{ variantId: second, quantity: 1 }],
      deadlineAt: at,
    },
    'order.cancelled': { channel: 'WEBSITE', orderId: uuid },
    'stock.reserved': {
      channel: 'WEBSITE',
      orderId: uuid,
      reservationId: second,
      warehouseId: uuid,
      branchId: second,
      expiresAt: at,
      total: '1000.00',
      items: [
        {
          jewelryItemId: uuid,
          variantId: second,
          sku: 'TEST',
          productName: 'Test',
          price: '1000.00',
        },
      ],
    },
    'stock.reserve_failed': { channel: 'WEBSITE', orderId: uuid, code: 'ITEM_NOT_AVAILABLE' },
    'stock.reservation_expired': { channel: 'WEBSITE', orderId: uuid, reservationId: second },
    'order.paid': {
      channel: 'WEBSITE',
      orderId: uuid,
      paymentId: second,
      reservationId: uuid,
      amount: '1000.00',
      currency: 'VND',
      receivedAt: at,
    },
    'stock.payment_result': {
      channel: 'WEBSITE',
      orderId: uuid,
      paymentId: second,
      reservationId: uuid,
      amount: '1000.00',
      currency: 'VND',
      version: 1,
      outcome: 'CONFIRMED',
      reason: null,
      holdUntil: at,
    },
  };
  const snapshot = fixtures['product.snapshot'];
  delete snapshot.inStock;
  snapshot.variants = snapshot.variants.map(({ id, sku, name, metalKind, estimatedPrice }) => ({
    id,
    sku,
    name,
    metalKind,
    estimatedPrice,
  }));
  for (const [key, payload] of Object.entries(fixtures)) {
    const schema = contracts.EVENT_PAYLOAD_SCHEMAS[key];
    assert.equal(schema.safeParse(payload).success, true, key);
    assert.equal(
      schema.safeParse({ ...payload, accessToken: 'secret', costPrice: '1.00' }).success,
      false,
      key,
    );
  }
  assert.equal(
    contracts.paymentInventoryResultSchema.safeParse({
      ...fixtures['stock.payment_result'],
      outcome: 'REJECTED',
      reason: null,
    }).success,
    false,
  );
});
test('6.5A domain bindings, handlers and retry/DLQ destinations cover all Phase 6 events', () => {
  const definitions = JSON.parse(read('infra/rabbitmq/definitions.json'));
  const required = {
    'inventory.events': ['order.created', 'order.cancelled', 'order.paid'],
    'sales.events': [
      'product.snapshot',
      'stock.availability_changed',
      'stock.reserved',
      'stock.reserve_failed',
      'stock.reservation_expired',
      'stock.payment_result',
    ],
  };
  for (const [queue, events] of Object.entries(required)) {
    assert.ok(definitions.queues.some((q) => q.name === queue));
    for (const event of events)
      assert.ok(
        definitions.bindings.some(
          (b) => b.source === 'domain.events' && b.destination === queue && b.routing_key === event,
        ),
        `${event} -> ${queue}`,
      );
    for (const suffix of ['retry.5s', 'retry.30s', 'retry.5m', 'dlq'])
      assert.ok(definitions.queues.some((q) => q.name === `${queue}.${suffix}`));
  }
  const inventory = read('apps/inventory/src/app.module.ts'),
    sales = read('apps/sales/src/app.module.ts');
  assert.ok(
    inventory.indexOf('...ONLINE_INVENTORY_HANDLERS') > inventory.indexOf('...POS_ORDER_HANDLERS'),
  );
  for (const name of [
    '...CATALOG_HANDLERS',
    '...ONLINE_SALES_HANDLERS',
    '[ROUTING_KEYS.STOCK_PAYMENT_RESULT]: onPaymentInventoryResult',
  ])
    assert.ok(sales.includes(name), name);
});
test('6.5A public schemas cannot carry PII/cost/internal IDs and payment requests reject mass assignment', () => {
  assert.equal(
    contracts.shopProductSchema.safeParse({ ...product, costPrice: '1.00' }).success,
    false,
  );
  for (const field of [
    'accessHash',
    'recipientPhone',
    'shippingAddress',
    'warehouseId',
    'branchId',
    'activePaymentId',
  ])
    assert.equal(
      contracts.onlineOrderViewSchema.safeParse({ ...order, [field]: 'secret' }).success,
      false,
      field,
    );
  const receipt = {
    bankTxnRef: 'TEST/ACCOUNT/123',
    amount: '1000.00',
    currency: 'VND',
    evidenceRef: 'test/statement/1',
  };
  assert.equal(contracts.confirmOnlinePaymentSchema.safeParse(receipt).success, true);
  for (const extra of [
    { status: 'INVENTORY_CONFIRMED' },
    { receivedAt: at },
    { actorId: uuid },
    { branchId: uuid },
  ])
    assert.equal(
      contracts.confirmOnlinePaymentSchema.safeParse({ ...receipt, ...extra }).success,
      false,
    );
  assert.equal(
    contracts.confirmOnlinePaymentSchema.safeParse({ ...receipt, amount: '0.00' }).success,
    false,
  );
});

test('6.5A prepared integration guards reject dev/prod ports, databases, roles and missing opt-in without connecting', async () => {
  const { ACK, requireAcknowledgement, databaseUrl, gatewayUrl, rabbitUrl } =
    await import('./test-environment.mjs');
  assert.throws(() => requireAcknowledgement({}));
  requireAcknowledgement({ PHASE6_TEST_EXECUTE: ACK });
  const db =
    'postgresql://inventory_user:guard-fixture@127.0.0.1:55432/phase6_test?schema=inventory';
  assert.equal(databaseUrl(db, 'inventory'), db);
  for (const invalid of [
    db.replace('55432', '5432'),
    db.replace('/phase6_test', '/jewelry'),
    db.replace('inventory_user', 'sales_user'),
    db.replace('schema=inventory', 'schema=sales'),
    db.replace('127.0.0.1', 'example.com'),
    undefined,
  ])
    assert.throws(() => databaseUrl(invalid, 'inventory'));
  assert.equal(gatewayUrl('http://127.0.0.1:3090'), 'http://127.0.0.1:3090');
  for (const invalid of [
    'http://127.0.0.1:3000',
    'http://example.com:3090',
    'http://user:pass@127.0.0.1:3090',
    'http://127.0.0.1:3090/?token=secret',
  ])
    assert.throws(() => gatewayUrl(invalid));
  const broker = 'amqp://phase6_app:guard-fixture@127.0.0.1:55672/%2F';
  assert.equal(rabbitUrl(broker), broker);
  assert.throws(() => rabbitUrl(broker.replace('55672', '5672')));
  const compose = parse(read('infra/phase6/compose.acceptance.yml'));
  assert.deepEqual(Object.keys(compose.services), ['postgres', 'rabbitmq']);
  assert.equal(compose.name, 'jewelry-phase6-acceptance');
  for (const service of Object.values(compose.services))
    for (const port of service.ports) assert.ok(port.startsWith('127.0.0.1:'));
});
