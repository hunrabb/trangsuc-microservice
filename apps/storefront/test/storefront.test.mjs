import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { createOnlineOrderSchema, shopQuerySchema } from '@jewelry/contracts';
const require = createRequire(import.meta.url);
const ts = require('typescript');
// Small in-process TS/TSX loader, matching the repository's existing SSR test approach.
// No browser, Docker or production API mock is installed by this suite.
registerHooks({
  load(url, context, nextLoad) {
    if (!/\.tsx?$/.test(url) || !url.includes('/storefront/src/')) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2023,
        },
      }).outputText,
    };
  },
});
const { createShopApi: createApi, ShopApiError, canRetryRead } = await import('../src/api/shop.ts');
const createShopApi = (fetcher) => createApi(fetcher, async () => undefined);
const { catalogQuery, catalogParams, cents, money, safeImageUrl, productPrice } =
  await import('../src/state/catalog.ts');
const {
  addCartItem,
  setCartQuantity,
  inspectCart,
  readCart,
  persistCart,
  CART_KEY,
  CART_TTL_MS,
  validateCart,
} = await import('../src/state/cart.ts');
const {
  CheckoutVault,
  CheckoutCoordinator,
  CheckoutStorageError,
  UncertainCheckoutError,
  CHECKOUT_KEY,
  ACCESS_TTL_MS,
  CHECKOUT_BODY_TTL_MS,
  orderPollInterval,
} = await import('../src/state/checkout.ts');
const { StoreProvider } = await import('../src/state/store.tsx');
const { StorefrontRoutes } = await import('../src/App.tsx');
const { OrderStatus, PaymentGuidance } = await import('../src/pages/orders.tsx');
const id = '11111111-1111-4111-8111-111111111111';
const variantId = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';
const categoryId = '44444444-4444-4444-8444-444444444444';
const token = 'ab'.repeat(32);
const product = {
  id,
  categoryId,
  categoryName: 'Nhẫn thử',
  name: 'Nhẫn dữ liệu kiểm thử',
  description: 'Mô tả từ API',
  imageUrl: null,
  capturedAt: '2026-11-09T00:00:00.000Z',
  inStock: true,
  variants: [
    {
      id: variantId,
      sku: 'TEST-SKU',
      name: 'Lựa chọn thực',
      metalKind: 'GOLD',
      estimatedPrice: '1000000.25',
      inStock: true,
    },
  ],
};
const body = {
  items: [{ variantId, quantity: 1 }],
  recipientName: 'Người kiểm thử',
  recipientPhone: '0901234567',
  shippingAddress: 'Địa chỉ chỉ dùng trong kiểm thử',
};
const order = {
  id: orderId,
  code: 'WEB-TEST',
  status: 'AWAITING_PAYMENT',
  total: '1000000.25',
  expiresAt: '2026-11-09T03:30:00.000Z',
  needsReview: false,
  failureCode: null,
  items: [{ variantId, sku: 'TEST-SKU', productName: product.name, price: '1000000.25' }],
};
function storage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function renderRoute(
  path,
  { data = [], errors = [], local = storage(), session = storage() } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  for (const [key, value] of data) client.setQueryData(key, value);
  for (const entry of errors) {
    const key = entry.key ?? entry;
    client
      .getQueryCache()
      .build(client, { queryKey: key })
      .setState({
        status: 'error',
        error: entry.error ?? new ShopApiError(503, 'SERVICE_UNAVAILABLE'),
      });
  }
  const previous = globalThis.window;
  globalThis.window = { localStorage: local, sessionStorage: session };
  try {
    return renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          StoreProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: [path] },
            React.createElement(StorefrontRoutes),
          ),
        ),
      ),
    );
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
    client.clear();
  }
}
const page = { items: [product], total: 25, page: 1, pageSize: 12 };

test('catalog URL preserves supported search, metal, category, price, sort and pagination', () => {
  const value = catalogQuery(
    new URLSearchParams(
      `search=nh%E1%BA%ABn&metalKind=GOLD&categoryId=${categoryId}&minPrice=100&maxPrice=9000&sort=price_desc&page=2&internal=true`,
    ),
  );
  assert.equal(value.success, true);
  assert.equal(value.data.page, 2);
  assert.equal(value.data.pageSize, 12);
  assert.equal(value.data.search, 'nhẫn');
  assert.equal(value.data.categoryId, categoryId);
  assert.equal(catalogQuery(catalogParams(value.data)).success, true);
  assert.equal(catalogParams(value.data).has('internal'), false);
});
test('catalog rejects malformed bounds, unsupported sort, UUID and page limits', () => {
  for (const text of [
    'page=0',
    'page=10001',
    'page=1.2',
    'metalKind=IRON',
    'sort=cost',
    'categoryId=bad',
    'minPrice=-1',
    'minPrice=20&maxPrice=10',
    'search=' + 'x'.repeat(101),
  ])
    assert.equal(catalogQuery(new URLSearchParams(text)).success, false, text);
});
test('money uses exact decimal arithmetic without floating point rounding', () => {
  assert.equal(cents('9007199254740993.01') * 3n, 2702159776422297903n);
  assert.equal(money('1000000.25'), '1.000.000,25\u00a0₫');
  assert.equal(money(null), 'Đang cập nhật giá');
});
test('product image URLs reject script, protocol-relative and credential URLs', () => {
  for (const text of [
    'javascript:alert(1)',
    '//evil.test/a',
    'http://evil.test/a',
    'https://user:pass@evil.test/a',
    '/\\evil.test/a',
  ])
    assert.equal(safeImageUrl(text), undefined);
  assert.equal(safeImageUrl('/media/ring.webp'), '/media/ring.webp');
  assert.equal(safeImageUrl('https://cdn.test/ring.webp'), 'https://cdn.test/ring.webp');
});
test('catalog API consumes real contract, serializes query and omits cookies', async () => {
  let request;
  const api = createShopApi(async (url, options) => {
    request = { url, options };
    return response(page);
  });
  const result = await api.list(
    shopQuerySchema.parse({ search: 'nhẫn & bạc', page: 2, pageSize: 12 }),
  );
  assert.equal(result.items[0].name, product.name);
  const url = new URL(request.url, 'https://shop.test');
  assert.equal(url.pathname, '/api/shop/products');
  assert.equal(url.searchParams.get('search'), 'nhẫn & bạc');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers.Authorization, undefined);
});
test('order API keeps checkout token and idempotency key only in headers', async () => {
  const calls = [];
  const key = crypto.randomUUID();
  const api = createShopApi(async (url, options) => {
    calls.push({ url, options });
    return response(order);
  });
  await api.create(body, token, key);
  await api.byKey(token, key);
  await api.order(orderId, token);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(!call.url.includes(token));
    assert.ok(!call.url.includes(key));
    assert.equal(call.options.headers.Authorization, `Checkout ${token}`);
    assert.equal(call.options.redirect, 'error');
  }
  assert.equal(calls[0].options.headers['Idempotency-Key'], key);
  assert.deepEqual(JSON.parse(calls[0].options.body), body);
  assert.equal(calls[1].url, '/api/shop/orders/by-key');
});
test('checkout API rejects frontend prices and invalid input before network', () => {
  let calls = 0;
  const api = createShopApi(async () => {
    calls++;
    return response(order);
  });
  assert.throws(() => api.create({ ...body, total: '1.00' }, token, crypto.randomUUID()));
  assert.throws(() => api.product('../../internal/orders'));
  assert.equal(calls, 0);
});
test('API never automatically retries failed POST and hides raw internal error details', async () => {
  let calls = 0;
  const api = createShopApi(async () => {
    calls++;
    throw new Error('secret database host');
  });
  await assert.rejects(
    api.create(body, token, crypto.randomUUID()),
    (error) => error instanceof ShopApiError && !error.message.includes('secret'),
  );
  assert.equal(calls, 1);
  const forbidden = createShopApi(async () =>
    response({ code: 'UNKNOWN_INTERNAL', message: 'secret connection string' }, 403),
  );
  await assert.rejects(
    forbidden.order(orderId, token),
    (error) => error.status === 403 && !error.message.includes('secret'),
  );
  assert.equal(canRetryRead(0, new ShopApiError(404, 'NOT_FOUND')), false);
  assert.equal(canRetryRead(0, new ShopApiError(503, 'SERVICE_UNAVAILABLE')), true);
  assert.equal(canRetryRead(1, new ShopApiError(503, 'SERVICE_UNAVAILABLE')), false);
});
test('API rejects DTOs carrying internal fields and handles unavailable products', async () => {
  const extra = createShopApi(async () => response({ ...product, costPrice: '1.00' }));
  await assert.rejects(extra.product(id), ShopApiError);
  const missing = createShopApi(async () => response({ message: 'inventory internals' }, 404));
  await assert.rejects(
    missing.product(id),
    (error) => error.status === 404 && !error.message.includes('inventory'),
  );
});
test('cart add/update/remove uses IDs only, stable row order and limits', () => {
  let items = addCartItem([], product, variantId, 1);
  items = addCartItem(items, product, variantId, 2);
  assert.equal(items[0].quantity, 3);
  assert.deepEqual(Object.keys(items[0]).sort(), ['productId', 'quantity', 'variantId']);
  assert.throws(() => addCartItem(items, product, variantId, 8));
  assert.throws(() => setCartQuantity(items, items[0], -1));
  const second = { ...items[0], variantId: orderId };
  const updated = setCartQuantity([...items, second], items[0], 4);
  assert.equal(updated[0].variantId, variantId);
  assert.equal(updated[0].quantity, 4);
  assert.deepEqual(setCartQuantity(items, items[0], 0), []);
});
test('cart refuses unavailable choices, duplicate variants and excessive basket', () => {
  assert.throws(() =>
    addCartItem(
      [],
      { ...product, variants: [{ ...product.variants[0], inStock: false }] },
      variantId,
      1,
    ),
  );
  assert.throws(() =>
    addCartItem(
      [],
      { ...product, variants: [{ ...product.variants[0], estimatedPrice: null }] },
      variantId,
      1,
    ),
  );
  const item = { productId: id, variantId, quantity: 1 };
  assert.throws(() => validateCart([item, item]));
  assert.throws(() =>
    validateCart(
      Array.from({ length: 6 }, () => ({ ...item, variantId: crypto.randomUUID(), quantity: 10 })),
    ),
  );
  assert.throws(() =>
    validateCart(Array.from({ length: 21 }, () => ({ ...item, variantId: crypto.randomUUID() }))),
  );
});
test('cart persists through refresh without prices or checkout token and enforces expiry/version', () => {
  const local = storage(),
    items = addCartItem([], product, variantId, 2);
  assert.equal(persistCart(local, items), true);
  assert.deepEqual(readCart(local), items);
  const raw = local.getItem(CART_KEY);
  assert.ok(!raw.includes('estimatedPrice'));
  assert.ok(!raw.includes('token'));
  assert.deepEqual(readCart(local, Date.now() + CART_TTL_MS + 1), []);
  local.setItem(CART_KEY, raw.replace('"version":1', '"version":2'));
  assert.deepEqual(readCart(local), []);
  local.setItem(CART_KEY, 'bad json');
  assert.deepEqual(readCart(local), []);
  assert.equal(persistCart(undefined, items), false);
});
test('cart rechecks current API availability and exact reference totals', () => {
  const items = addCartItem([], product, variantId, 3);
  let result = inspectCart(items, new Map([[id, product]]));
  assert.equal(result.ready, true);
  assert.equal(result.total, 300000075n);
  result = inspectCart(items, new Map());
  assert.equal(result.ready, false);
  assert.equal(result.total, null);
  result = inspectCart(
    items,
    new Map([[id, { ...product, variants: [{ ...product.variants[0], inStock: false }] }]]),
  );
  assert.equal(result.ready, false);
});
test('checkout validates contact details and forbids price fields using shared schema', () => {
  assert.equal(createOnlineOrderSchema.safeParse(body).success, true);
  for (const invalid of [
    { recipientName: '' },
    { recipientPhone: 'abc' },
    { shippingAddress: 'short' },
    { email: 'bad' },
    { price: '1.00' },
    { items: [{ variantId, quantity: 11 }] },
  ])
    assert.equal(createOnlineOrderSchema.safeParse({ ...body, ...invalid }).success, false);
});
test('double submission shares one request; identity is stored before POST; known order removes PII', async () => {
  const session = storage(),
    vault = new CheckoutVault(session);
  let calls = 0,
    finish;
  const coordinator = new CheckoutCoordinator(
    {
      create: async (_body, _token, key) => {
        calls++;
        const saved = JSON.parse(session.getItem(CHECKOUT_KEY)).attempts[0];
        assert.equal(saved.sent, true);
        assert.equal(saved.key, key);
        return new Promise((resolve) => (finish = resolve));
      },
    },
    vault,
  );
  const first = coordinator.submit(body),
    second = coordinator.submit(body);
  assert.equal(first, second);
  assert.equal(coordinator.busy, true);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(order);
  await first;
  assert.equal(coordinator.busy, false);
  assert.equal(vault.forOrder(orderId).orderId, orderId);
  assert.equal(vault.active(), undefined);
  assert.ok(!session.getItem(CHECKOUT_KEY).includes(body.recipientPhone));
  assert.equal(vault.forOrder(orderId).body, null);
});
test('timeout retains uncertain checkout; explicit retry reuses exact token/key/body even after reload', async () => {
  const session = storage(),
    vault = new CheckoutVault(session),
    calls = [];
  const api = {
    create: async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw new ShopApiError(0, 'UNAVAILABLE');
      return order;
    },
  };
  await assert.rejects(new CheckoutCoordinator(api, vault).submit(body), UncertainCheckoutError);
  assert.equal(calls.length, 1);
  const restored = new CheckoutVault(session);
  const identity = restored.active();
  assert.ok(identity);
  await assert.rejects(new CheckoutCoordinator(api, restored).submit(body), UncertainCheckoutError);
  await new CheckoutCoordinator(api, restored).retrySame();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
});
test('uncertain checkout recovers by key; 404 never clears request or permits a fresh identity', async () => {
  const vault = new CheckoutVault(storage());
  const attempt = vault.prepare(body);
  let posts = 0;
  const api = {
    create: async () => {
      posts++;
      return order;
    },
    byKey: async () => {
      throw new ShopApiError(404, 'NOT_FOUND');
    },
  };
  const coordinator = new CheckoutCoordinator(api, vault);
  await assert.rejects(coordinator.recover(), (error) => error.status === 404);
  assert.equal(vault.active().key, attempt.key);
  assert.throws(() => vault.startNew(), UncertainCheckoutError);
  assert.throws(() => vault.forget(attempt.id), UncertainCheckoutError);
  await assert.rejects(coordinator.submit(body), UncertainCheckoutError);
  assert.equal(posts, 0);
  api.byKey = async (t, k) => {
    assert.equal(t, attempt.token);
    assert.equal(k, attempt.key);
    return order;
  };
  await coordinator.recover();
  assert.equal(vault.forOrder(orderId).orderId, orderId);
  assert.equal(vault.active(), undefined);
});
test('checkout never sends POST when session storage is unavailable or full', async () => {
  for (const session of [
    undefined,
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    },
  ]) {
    let calls = 0;
    const coordinator = new CheckoutCoordinator(
      {
        create: async () => {
          calls++;
          return order;
        },
      },
      new CheckoutVault(session),
    );
    await assert.rejects(coordinator.submit(body), CheckoutStorageError);
    assert.equal(calls, 0);
  }
});
test('vault removes PII after 30 minutes but preserves unresolved lookup identity for 72 hours', () => {
  const session = storage(),
    vault = new CheckoutVault(session),
    attempt = vault.prepare(body);
  const restored = new CheckoutVault(session, attempt.createdAt + CHECKOUT_BODY_TTL_MS + 1);
  assert.equal(restored.active().body, null);
  assert.equal(restored.active().key, attempt.key);
  assert.throws(() => restored.startNew(), UncertainCheckoutError);
  assert.ok(!session.getItem(CHECKOUT_KEY).includes(body.shippingAddress));
  const expired = new CheckoutVault(session, attempt.expiresAt + 1);
  assert.equal(expired.list().length, 0);
  assert.ok(!session.getItem(CHECKOUT_KEY).includes(attempt.token));
});
test('known credentials keep original expiry on polling; invalid stored row cannot erase valid recovery', () => {
  const session = storage(),
    vault = new CheckoutVault(session),
    attempt = vault.prepare(body);
  vault.known(attempt, order);
  vault.known(vault.forOrder(orderId), { ...order, status: 'CONFIRMED' });
  assert.equal(vault.forOrder(orderId).expiresAt, attempt.createdAt + ACCESS_TTL_MS);
  const saved = JSON.parse(session.getItem(CHECKOUT_KEY));
  saved.attempts.push({ id: 'invalid' });
  session.setItem(CHECKOUT_KEY, JSON.stringify(saved));
  assert.equal(new CheckoutVault(session).forOrder(orderId).key, attempt.key);
});
test('importing another order cannot bypass unresolved checkout, tokens are strictly validated', () => {
  const vault = new CheckoutVault(storage()),
    attempt = vault.prepare(body);
  vault.importAccess(orderId, token);
  assert.equal(vault.active().id, attempt.id);
  assert.throws(() => vault.startNew(), UncertainCheckoutError);
  assert.throws(() => vault.importAccess(orderId, 'short'));
});
test('polling is bounded by lifecycle; terminal and refund-request statuses do not imply payment success', () => {
  assert.equal(orderPollInterval({ ...order, status: 'PENDING' }), 3000);
  assert.equal(orderPollInterval(order), 5000);
  assert.equal(orderPollInterval({ ...order, status: 'PAYMENT_REVIEW' }), 15000);
  for (const status of ['CONFIRMED', 'CANCELLED', 'REFUND_PENDING'])
    assert.equal(orderPollInterval({ ...order, status }), false);
});
test('home renders API catalog and observed categories without invented product photos or claims', () => {
  const html = renderRoute('/', { data: [[['catalog', 'home'], page]] });
  assert.ok(html.includes(product.name));
  assert.ok(html.includes(product.categoryName));
  assert.ok(html.includes('Hình ảnh đang được cập nhật'));
  assert.ok(!html.includes('unsplash'));
  assert.ok(html.includes(`href="/san-pham/${id}"`));
  assert.ok(html.includes('Vẻ đẹp tinh giản.'));
});
test('catalog renders filtered results, search/sort form, category and pagination controls', () => {
  const params = new URLSearchParams('search=nhẫn&sort=price_asc&page=2&metalKind=GOLD');
  const query = catalogQuery(params).data;
  const html = renderRoute(`/bo-suu-tap?${params}`, {
    data: [[['catalog', query], { ...page, page: 2 }]],
  });
  for (const text of [
    product.name,
    'name="search"',
    'name="sort"',
    'name="minPrice"',
    'name="maxPrice"',
    'name="categoryId"',
    'value="nhẫn"',
    'Trang sau',
    'Phân trang sản phẩm',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes('aria-controls="catalog-filters"'));
  assert.ok(html.includes('aria-expanded="false"'));
});
test('catalog supplies loading, empty, error/retry and invalid URL states', () => {
  const key = ['catalog', shopQuerySchema.parse({ pageSize: 12 })];
  assert.ok(renderRoute('/bo-suu-tap').includes('aria-busy="true"'));
  assert.ok(
    renderRoute('/bo-suu-tap', { data: [[key, { ...page, items: [], total: 0 }]] }).includes(
      'Chưa tìm thấy lựa chọn phù hợp',
    ),
  );
  assert.ok(renderRoute('/bo-suu-tap', { errors: [key] }).includes('Chưa thể tải bộ sưu tập'));
  assert.ok(renderRoute('/bo-suu-tap?page=-1').includes('Bộ lọc chưa hợp lệ'));
});
test('product detail renders actual DTO fields and disables add for sold/unavailable choices', () => {
  let html = renderRoute(`/san-pham/${id}`, { data: [[['product', id], product]] });
  for (const text of [
    product.name,
    'TEST-SKU',
    'Mô tả từ API',
    'Thêm vào giỏ',
    'Theo chiếc',
    '1.000.000,25',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes('Trọng lượng'));
  assert.ok(html.includes('aria-label="Tăng số lượng:'));
  html = renderRoute(`/san-pham/${id}`, {
    data: [
      [
        ['product', id],
        { ...product, inStock: false, variants: [{ ...product.variants[0], inStock: false }] },
      ],
    ],
  });
  assert.match(html, /<button class="button button-dark" disabled="">/);
  assert.ok(html.includes('Lựa chọn này hiện chưa khả dụng'));
  assert.ok(renderRoute('/san-pham/not-a-uuid').includes('Sản phẩm hiện không khả dụng'));
});
test('cart survives refresh and renders unavailable/unpublished product with checkout blocked', () => {
  const local = storage();
  persistCart(local, addCartItem([], product, variantId, 2));
  let html = renderRoute('/gio-hang', { local, data: [[['product', id], product]] });
  assert.ok(html.includes(product.name));
  assert.ok(html.includes('Tiếp tục đặt hàng'));
  assert.ok(html.includes('2.000.000,50'));
  html = renderRoute('/gio-hang', { local, errors: [['product', id]] });
  assert.ok(html.includes('Sản phẩm hiện không khả dụng'));
  assert.ok(html.includes('Kiểm tra sản phẩm để tiếp tục'));
  assert.ok(html.includes('Bỏ khỏi giỏ'));
});
test('checkout form has accessible labels and sends only required contact fields', () => {
  const local = storage();
  persistCart(local, addCartItem([], product, variantId, 1));
  const html = renderRoute('/dat-hang', { local, data: [[['product', id], product]] });
  for (const text of [
    'for="checkout-recipientName"',
    'for="checkout-recipientPhone"',
    'for="checkout-address"',
    'name="shippingAddress"',
    'Gửi yêu cầu đặt hàng',
    'Bước này chưa xác nhận',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes('name="price"'));
  assert.ok(!html.includes('name="total"'));
});
test('checkout reload shows recovery actions rather than a new checkout form', () => {
  const session = storage();
  new CheckoutVault(session).prepare(body);
  const html = renderRoute('/dat-hang', { session });
  assert.ok(html.includes('Kiểm tra kết quả đã gửi'));
  assert.ok(html.includes('Gửi lại đúng yêu cầu đã lưu'));
  assert.ok(!html.includes('name="recipientPhone"'));
  assert.ok(!html.includes(token));
});
test('demo payment shows authoritative amount, explicit non-payment QR and local action', () => {
  const html = renderToStaticMarkup(React.createElement(PaymentGuidance, { order }));
  for (const text of [
    '1.000.000,25',
    'WEB-TEST',
    'DEMO — KHÔNG CHUYỂN TIỀN THẬT',
    'Tôi đã chuyển khoản (Demo)',
    'không gửi thông báo đến cửa hàng',
    'không chứa ngân hàng',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes('role="img"'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('vietqr'));
  assert.equal(order.status, 'AWAITING_PAYMENT');
});
test('demo payment is hidden for every non-payable lifecycle and missing authoritative total', () => {
  for (const status of [
    'PENDING',
    'CANCELLED',
    'PAYMENT_PROCESSING',
    'CONFIRMED',
    'PAYMENT_REVIEW',
    'REFUND_PENDING',
  ]) {
    assert.equal(
      renderToStaticMarkup(React.createElement(PaymentGuidance, { order: { ...order, status } })),
      '',
    );
  }
  for (const patch of [{ total: null }, { needsReview: true }])
    assert.equal(
      renderToStaticMarkup(React.createElement(PaymentGuidance, { order: { ...order, ...patch } })),
      '',
    );
});
test('payment and refund status components never claim completion before backend confirmation', () => {
  for (const status of ['PAYMENT_PROCESSING', 'PAYMENT_REVIEW', 'REFUND_PENDING', 'CONFIRMED']) {
    const html = renderToStaticMarkup(
      React.createElement(OrderStatus, { order: { ...order, status } }),
    );
    assert.ok(html.includes('aria-live="polite"'));
    assert.ok(!html.includes('Đã giao hàng'));
    if (status === 'REFUND_PENDING')
      assert.ok(html.includes('Chưa có xác nhận khoản tiền đã được hoàn.'));
    if (status === 'CONFIRMED') assert.ok(html.includes('Chưa có thông tin giao hàng.'));
  }
});
test('order route with missing authorization requests private access without exposing token in URL', () => {
  const html = renderRoute(`/don-hang/${orderId}`);
  assert.ok(html.includes('type="password"'));
  assert.ok(html.includes('Mã truy cập riêng'));
  assert.ok(!html.includes('Sản phẩm trong đơn'));
  assert.ok(!html.includes('?token='));
  assert.ok(!html.includes('Authorization'));
});
test('authorized tracking renders order and pending payment; auth error gives safe retry', () => {
  const session = storage(),
    attempt = new CheckoutVault(session).importAccess(orderId, token),
    key = ['private-order', attempt.id, orderId];
  let html = renderRoute(`/don-hang/${orderId}`, { session, data: [[key, order]] });
  for (const text of [
    'WEB-TEST',
    'Đang chờ thanh toán',
    'Thời gian giữ sản phẩm',
    'Sao chép mã truy cập riêng',
    'Hiện mã để tự lưu riêng',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes(token));
  assert.ok(!html.includes('recipientPhone'));
  assert.ok(!html.includes('Tôi đã trả tiền'));
  html = renderRoute(`/don-hang/${orderId}`, {
    session,
    errors: [{ key, error: new ShopApiError(403, 'FORBIDDEN') }],
  });
  assert.ok(html.includes('Chưa thể truy cập đơn'));
  assert.ok(html.includes('Kiểm tra lại'));
  assert.ok(!html.includes('WEB-TEST'));
});
test('responsive navigation has menu controls, skip link, named landmarks and reduced-motion styling', () => {
  const html = renderRoute('/huong-dan');
  for (const text of [
    'aria-controls="main-nav"',
    'aria-expanded="false"',
    'aria-label="Mở menu"',
    'href="#main-content"',
    'id="main-content"',
    'aria-label="Điều hướng chính"',
  ])
    assert.ok(html.includes(text), text);
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  for (const text of [
    '@media (max-width: 850px)',
    '@media (max-width: 600px)',
    'prefers-reduced-motion',
    ':focus-visible',
    '.main-nav.is-open',
    'min-height: 44px',
  ])
    assert.ok(css.includes(text), text);
});

test('order needsReview renders a clear warning while preserving the backend status', () => {
  const html = renderToStaticMarkup(
    React.createElement(OrderStatus, { order: { ...order, status: 'PENDING', needsReview: true } }),
  );
  assert.ok(html.includes('Đang kiểm tra sản phẩm'));
  assert.ok(html.includes('Yêu cầu cần được cửa hàng kiểm tra thêm.'));
  assert.ok(!html.includes('Đơn hàng đã được xác nhận'));
});

test('corrected order access replaces a previously mistyped token for the same order', () => {
  const vault = new CheckoutVault(storage());
  const wrong = vault.importAccess(orderId, 'cd'.repeat(32));
  const corrected = vault.importAccess(orderId, token);
  assert.equal(vault.forOrder(orderId).id, corrected.id);
  assert.equal(vault.forOrder(orderId).token, token);
  assert.notEqual(vault.forOrder(orderId).id, wrong.id);
});

// Task 6.5A regressions: the API returns all variants while SQL sorts/filters matching ones.
test('6.5A reference price matches metal and price filters with exact decimal bounds', () => {
  const mixed = {
    ...product,
    variants: [
      ...product.variants,
      { ...product.variants[0], id: categoryId, metalKind: 'SILVER', estimatedPrice: '500000.00' },
    ],
  };
  const query = shopQuerySchema.parse({
    metalKind: 'GOLD',
    minPrice: '900000',
    maxPrice: '1500000',
  });
  assert.equal(productPrice(mixed, query), 100000025n);
  assert.equal(productPrice(mixed, { minPrice: '1000000.25', maxPrice: '1000000.25' }), 100000025n);
  assert.equal(productPrice(mixed, { minPrice: '1000000.26' }), null);
  assert.equal(productPrice(mixed), 50000000n);
});
test('6.5A filtered catalog card cannot advertise another variant price or stock', () => {
  const mixed = {
    ...product,
    variants: [
      { ...product.variants[0], inStock: false },
      { ...product.variants[0], id: categoryId, metalKind: 'SILVER', estimatedPrice: '500000.00' },
    ],
  };
  const params = new URLSearchParams('metalKind=GOLD&minPrice=900000&maxPrice=1500000');
  const query = catalogQuery(params).data;
  const html = renderRoute(`/bo-suu-tap?${params}`, {
    data: [[['catalog', query], { ...page, items: [mixed], total: 1 }]],
  });
  assert.ok(html.includes('1.000.000,25'));
  assert.ok(!html.includes('500.000'));
  assert.ok(html.includes('Tạm hết hàng'));
  assert.ok(!html.includes('>Còn hàng<'));
});

test('signed-in checkout uses customer endpoint and bearer without accepting frontend accountId', async () => {
  let request;
  const api = createApi(
    async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify(order), { status: 202 });
    },
    async () => 'verified-access-token',
  );
  await api.create(
    {
      items: [{ variantId, quantity: 1 }],
      recipientName: 'Khách',
      recipientPhone: '+84901234567',
      shippingAddress: '123 Đường A, TP HCM',
    },
    token,
    'account-checkout',
  );
  assert.equal(request.url, '/api/shop/my-orders');
  assert.equal(request.options.headers.Authorization, 'Bearer verified-access-token');
  assert.equal(request.options.headers['X-Checkout-Authorization'], `Checkout ${token}`);
  assert.ok(!request.options.body.includes('accountId'));
});

test('account pages request login, render owned orders and preserve guest access separately', async () => {
  const accountApi = await import('../src/api/account.ts');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await accountApi.restoreAccount();
    let html = renderRoute('/tai-khoan/don-hang');
    assert.ok(html.includes('Đăng nhập'));
    assert.ok(!html.includes('ID tra cứu đơn'));
    assert.ok(!html.includes('WEB-TEST'));
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          accessToken: 'access',
          expiresIn: 900,
          user: { id, fullName: 'Khách A', email: 'a@example.com' },
        }),
      );
    await accountApi.loginAccount('login', { email: 'a@example.com', password: 'long-password' });
    const owned = { ...order, createdAt: '2026-11-10T01:00:00.000Z' };
    html = renderRoute('/tai-khoan/don-hang', {
      data: [[['account-orders', id, 1], { items: [owned], total: 1, page: 1, pageSize: 20 }]],
    });
    for (const text of ['WEB-TEST', 'Khách A', 'Xem chi tiết', '1.000.000,25'])
      assert.ok(html.includes(text), text);
    assert.ok(!html.includes('ID tra cứu đơn'));
    assert.ok(renderRoute('/tai-khoan/don-hang').includes('Đang tải đơn hàng'));
    html = renderRoute('/tai-khoan/don-hang', {
      errors: [{ key: ['account-orders', id, 1], error: new Error('Chưa tải được đơn hàng') }],
    });
    assert.ok(html.includes('Chưa tải được đơn hàng'));
    assert.ok(html.includes('Thử lại'));
    html = renderRoute(`/tai-khoan/don-hang/${orderId}`, {
      data: [[['account-orders', id, orderId], owned]],
    });
    assert.ok(html.includes('Sản phẩm trong đơn'));
    assert.ok(html.includes('Số lượng: 1'));
    html = renderRoute('/tai-khoan/don-hang', {
      data: [[['account-orders', id, 1], { items: [], total: 0, page: 1, pageSize: 20 }]],
    });
    assert.ok(html.includes('Bạn chưa có đơn hàng nào'));
    await accountApi.logoutAccount();
    html = renderRoute('/tai-khoan/don-hang', {
      data: [[['account-orders', id, 1], { items: [owned], total: 1, page: 1, pageSize: 20 }]],
    });
    assert.ok(!html.includes('WEB-TEST'));
    assert.ok(renderRoute('/don-hang/khach').includes('Mã truy cập riêng'));
  } finally {
    globalThis.fetch = original;
  }
});

test('catalog metal navigation shows the selected collection heading and one active menu link', () => {
  for (const [kind, label] of [
    ['GOLD', 'Trang sức vàng'],
    ['SILVER', 'Trang sức bạc'],
  ]) {
    const html = renderRoute(`/bo-suu-tap?metalKind=${kind}`);
    assert.match(html, new RegExp(`<h1>${label}`));
    assert.match(
      html,
      new RegExp(
        `href="/bo-suu-tap\\?metalKind=${kind}"[^>]*aria-current="page"|aria-current="page"[^>]*href="/bo-suu-tap\\?metalKind=${kind}"`,
      ),
    );
    assert.ok(!html.includes('class="active" aria-current="page" href="/bo-suu-tap"'));
  }
});

test('known orders are history, never checkout recovery, including legacy stored activeId', () => {
  for (const status of [
    'CANCELLED',
    'CONFIRMED',
    'AWAITING_PAYMENT',
    'PENDING',
    'PAYMENT_PROCESSING',
    'PAYMENT_REVIEW',
    'REFUND_PENDING',
  ]) {
    const session = storage(),
      local = storage();
    persistCart(local, addCartItem([], product, variantId, 1));
    const vault = new CheckoutVault(session),
      attempt = vault.prepare(body);
    vault.known(attempt, { ...order, status });
    assert.equal(vault.active(), undefined);
    const saved = JSON.parse(session.getItem(CHECKOUT_KEY));
    saved.activeId = attempt.id; // Sessions created before this fix.
    session.setItem(CHECKOUT_KEY, JSON.stringify(saved));
    const restored = new CheckoutVault(session);
    assert.equal(restored.active(), undefined);
    assert.equal(restored.forOrder(orderId).lastStatus, status);
    const html = renderRoute('/dat-hang', { session, local, data: [[['product', id], product]] });
    assert.ok(html.includes('name="recipientName"'), status);
    assert.ok(!html.includes('Yêu cầu trước đã kết thúc'), status);
    assert.ok(!html.includes('Đặt đơn mới từ giỏ hàng'), status);
    const fresh = restored.prepare(body);
    assert.notEqual(fresh.key, attempt.key);
    assert.notEqual(fresh.token, attempt.token);
  }
});
test('empty cart with known order history shows empty cart instead of old order status', () => {
  const session = storage(),
    vault = new CheckoutVault(session),
    attempt = vault.prepare(body);
  vault.known(attempt, { ...order, status: 'CANCELLED' });
  const html = renderRoute('/dat-hang', { session });
  assert.ok(html.includes('Bạn chưa có sản phẩm để đặt'));
  assert.ok(!html.includes('Yêu cầu trước đã kết thúc'));
});
test('expired tracking explains the actual previous reservation deadline in Vietnam time', () => {
  const html = renderToStaticMarkup(
    React.createElement(OrderStatus, {
      order: {
        ...order,
        status: 'CANCELLED',
        failureCode: 'RESERVATION_EXPIRED',
        expiresAt: '2026-11-10T10:41:45.320Z',
      },
    }),
  );
  assert.ok(html.includes('17:41:45'));
  assert.ok(html.includes('Mở lại liên kết không bắt đầu lượt giữ hàng mới'));
});

test('late tracking updates cannot reactivate a completed intent after starting another purchase', async () => {
  const session = storage();
  const vault = new CheckoutVault(session);
  const first = vault.prepare(body);
  vault.known(first, { ...order, status: 'CANCELLED' });
  const trackingSnapshot = vault.forOrder(orderId);
  vault.startNew();
  // React tracking effect can still run while the navigation to cart commits.
  vault.known(trackingSnapshot, { ...order, status: 'CANCELLED' });
  assert.equal(vault.active(), undefined);
  const restored = new CheckoutVault(session);
  assert.equal(restored.active(), undefined);
  const next = restored.prepare(body);
  assert.notEqual(next.key, first.key);
  assert.notEqual(next.token, first.token);
  // Revisiting history must not replace the active pending request or its key/body.
  restored.known(restored.forOrder(orderId), { ...order, status: 'CANCELLED' });
  assert.equal(restored.active().id, next.id);
  assert.equal(restored.active().key, next.key);
  assert.deepEqual(restored.active().body, body);
  const reloaded = new CheckoutVault(session);
  assert.equal(reloaded.active().key, next.key);
  assert.throws(() => reloaded.startNew(), UncertainCheckoutError);
});
test('late tracking callbacks cannot restore forgotten credentials', () => {
  const vault = new CheckoutVault(storage());
  const attempt = vault.prepare(body);
  vault.known(attempt, order);
  vault.forget(attempt.id);
  vault.known(attempt, order);
  assert.equal(vault.active(), undefined);
  assert.equal(vault.forOrder(orderId), undefined);
});
