import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
if (process.env.RUN_REBUY_DEVELOPMENT !== '1')
  throw new Error(
    'This test creates demo orders and expires one test reservation. Set RUN_REBUY_DEVELOPMENT=1 only for local development.',
  );
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const base = process.env.TEST_BASE || 'http://localhost:8081';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const folder = fileURLToPath(new URL('../../../secrets/rebuy-audit/', import.meta.url));
const publicOut = fileURLToPath(new URL('./evidence/rebuy/', import.meta.url));
mkdirSync(publicOut, { recursive: true });
mkdirSync(folder, { recursive: true, mode: 0o700 });
const trace = [],
  orders = new Map(),
  posts = [];
let stage = 'B';
function sql(service, query) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      `jewelry-${service}-postgres-1`,
      'sh',
      '-c',
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At',
    ],
    { input: query, encoding: 'utf8' },
  ).trim();
}
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const jobs = [];
page.on('response', (r) => {
  if (r.url().endsWith('/api/shop/orders') && r.request().method() === 'POST')
    jobs.push(
      (async () => {
        const body = await r.json();
        if (!body.id) return;
        const headers = r.request().headers(),
          a = {
            id: body.id,
            key: headers['idempotency-key'],
            auth: headers.authorization,
            body: r.request().postDataJSON(),
          };
        orders.set(a.id, a);
        posts.push(a);
        trace.push({
          stage,
          urlBefore: '/dat-hang',
          request: '/api/shop/orders',
          http: r.status(),
          key: a.key,
          responseOrderId: a.id,
          status: body.status,
        });
      })(),
    );
});
async function wait(fn, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('Timeout ' + label);
}
async function data(id) {
  const a = orders.get(id);
  const r = await page.request.get(base + '/api/shop/orders/' + id, {
    headers: { Authorization: a.auth },
  });
  assert(r.ok());
  return r.json();
}
async function fill() {
  await page.getByLabel('Họ và tên', { exact: true }).fill('Rebuy integration DEMO');
  await page.getByLabel('Số điện thoại', { exact: true }).fill('0990000999');
  await page
    .getByLabel('Địa chỉ nhận hàng', { exact: true })
    .fill('Địa chỉ development, không giao hàng');
}
async function submit() {
  await fill();
  await page.getByRole('button', { name: 'Gửi yêu cầu đặt hàng', exact: true }).click();
  await page.waitForURL('**/don-hang/*');
  await page.locator('.demo-payment').waitFor();
  await Promise.all(jobs);
  const id = page.url().split('/').pop();
  assert(orders.has(id));
  assert.equal(posts.at(-1).id, id);
  trace.push({ stage, navigatedOrderId: id, actualStatus: (await data(id)).status });
  return id;
}
async function cancel(id) {
  const a = orders.get(id);
  const r = await page.request.post(base + '/api/shop/orders/' + id + '/cancel', {
    headers: { Authorization: a.auth },
  });
  assert(r.ok());
  await wait(
    () =>
      sql(
        'inventory',
        `SELECT status FROM inventory."StockReservation" WHERE "orderId"='${id}'::uuid;`,
      ) === 'RELEASED',
    'release',
  );
}
async function cartToCheckout() {
  await page
    .getByRole('button', { name: 'Quay lại giỏ để đặt một đơn khác', exact: false })
    .click();
  await page.locator('.cart-line').waitFor();
  await page.getByRole('link', { name: 'Tiếp tục đặt hàng', exact: true }).click();
  await page.getByLabel('Họ và tên', { exact: true }).waitFor();
}
let error;
try {
  await page.goto(base + '/bo-suu-tap');
  await page.locator('.product-card-link').first().click();
  await page.getByRole('button', { name: 'Thêm vào giỏ', exact: true }).click();
  await page.goto(base + '/dat-hang');
  const first = await submit(),
    a = orders.get(first);
  stage = 'A';
  const retried = await page.request.post(base + '/api/shop/orders', {
    headers: { Authorization: a.auth, 'Idempotency-Key': a.key },
    data: a.body,
  });
  assert.equal(retried.status(), 202);
  assert.equal((await retried.json()).id, first);
  trace.push({ stage, key: a.key, first, retryReturns: first, http: retried.status() });
  await page.getByRole('button', { name: 'Tôi muốn huỷ yêu cầu này', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận huỷ yêu cầu', exact: true }).click();
  await page.getByRole('heading', { name: 'Yêu cầu đặt hàng đã kết thúc', exact: true }).waitFor();
  await wait(
    () =>
      sql(
        'inventory',
        `SELECT status FROM inventory."StockReservation" WHERE "orderId"='${first}'::uuid;`,
      ) === 'RELEASED',
    'first release',
  );
  stage = 'B';
  await cartToCheckout();
  const second = await submit(),
    b = orders.get(second);
  assert.notEqual(first, second);
  assert.notEqual(a.key, b.key);
  stage = 'C';
  await page.reload();
  await page.locator('.demo-payment').waitFor();
  assert(page.url().endsWith(second));
  assert.equal((await data(second)).status, 'AWAITING_PAYMENT');
  // Opening known history must never occupy the form for a new cart purchase.
  await page.goto(base + '/don-hang/' + first);
  await page.getByRole('heading', { name: 'Yêu cầu đặt hàng đã kết thúc', exact: true }).waitFor();
  await page.goto(base + '/dat-hang');
  await page.getByLabel('Họ và tên', { exact: true }).waitFor();
  await page.reload();
  await page.getByLabel('Họ và tên', { exact: true }).waitFor();
  trace.push({ stage, refreshOrder: second, historicalOrderDoesNotReplaceActive: true });
  stage = 'E';
  // Advance expiry ONLY on this newly-created test reservation; normal workers perform release/cancel.
  assert.equal(
    sql('sales', `SELECT "recipientName" FROM sales."OnlineOrder" WHERE id='${second}'::uuid;`),
    'Rebuy integration DEMO',
  );
  sql(
    'sales',
    `UPDATE sales."OnlineOrder" SET "deadlineAt"=clock_timestamp()-interval '1 second',"expiresAt"=clock_timestamp()-interval '1 second',"recoveryAfter"=clock_timestamp()-interval '1 second' WHERE id='${second}'::uuid AND status='AWAITING_PAYMENT' AND "recipientName"='Rebuy integration DEMO';`,
  );
  sql(
    'inventory',
    `UPDATE inventory."StockReservation" SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "orderId"='${second}'::uuid AND status='ACTIVE';`,
  );
  await wait(
    () =>
      sql(
        'inventory',
        `SELECT status FROM inventory."StockReservation" WHERE "orderId"='${second}'::uuid;`,
      ) === 'EXPIRED' &&
      sql('sales', `SELECT status FROM sales."OnlineOrder" WHERE id='${second}'::uuid;`) ===
        'CANCELLED',
    'normal expiry workers',
  );
  await page.goto(base + '/don-hang/' + second);
  await page.getByRole('heading', { name: 'Yêu cầu đặt hàng đã kết thúc', exact: true }).waitFor();
  await cartToCheckout();
  const third = await submit(),
    c = orders.get(third);
  assert.notEqual(third, second);
  assert.notEqual(c.key, b.key);
  const thirdView = await data(third);
  assert(Date.parse(thirdView.expiresAt) > Date.now() + 28 * 60000);
  const reservations = JSON.parse(
    sql(
      'inventory',
      `SELECT json_agg(json_build_object('id',id,'orderId',"orderId",'status',status,'expiresAt',"expiresAt")) FROM inventory."StockReservation" WHERE "orderId" IN ('${first}','${second}','${third}');`,
    ),
  );
  assert.equal(new Set(reservations.map((r) => r.id)).size, 3);
  const duplicates = sql(
    'inventory',
    `SELECT count(*) FROM (SELECT "jewelryItemId" FROM inventory."StockReservationItem" WHERE "isActive"=true GROUP BY "jewelryItemId" HAVING count(*)>1) d;`,
  );
  assert.equal(duplicates, '0');
  trace.push({
    stage,
    newOrder: third,
    newKey: c.key,
    newStatus: thirdView.status,
    newExpiresAt: thirdView.expiresAt,
    reservations,
    noDuplicateActivePhysicalItem: true,
  });
  await page.screenshot({ path: publicOut + '/new-order.png', fullPage: true });
  await cancel(third);
  await page.goto(base + '/don-hang/' + third);
  await page.getByRole('heading', { name: 'Yêu cầu đặt hàng đã kết thúc', exact: true }).waitFor();
  await cartToCheckout();
  stage = 'D';
  let dropped;
  await page.route('**/api/shop/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const upstream = await route.fetch();
    const body = await upstream.json();
    const h = route.request().headers();
    dropped = {
      id: body.id,
      key: h['idempotency-key'],
      auth: h.authorization,
      body: route.request().postDataJSON(),
    };
    orders.set(body.id, dropped);
    await route.abort('failed');
  });
  await fill();
  await page.getByRole('button', { name: 'Gửi yêu cầu đặt hàng', exact: true }).click();
  await page.getByRole('button', { name: 'Kiểm tra kết quả đã gửi', exact: true }).waitFor();
  assert(dropped);
  const stored = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('jewelry.storefront.checkout.v1')),
  );
  assert.equal(stored.attempts.find((a) => a.id === stored.activeId).key, dropped.key);
  assert.equal(stored.attempts.find((a) => a.id === stored.activeId).orderId, null);
  await page.unroute('**/api/shop/orders');
  await page.reload();
  await page.getByRole('button', { name: 'Gửi lại đúng yêu cầu đã lưu', exact: true }).click();
  await page.waitForURL('**/don-hang/' + dropped.id);
  await page.locator('.demo-payment').waitFor();
  await Promise.all(jobs);
  assert.equal(posts.at(-1).key, dropped.key);
  assert.equal(posts.at(-1).id, dropped.id);
  trace.push({
    stage,
    responseDroppedAfterBackendCreate: true,
    retryKey: dropped.key,
    retryReturns: dropped.id,
    newKeyWasNotGenerated: true,
  });
  const ids = [...orders.keys()].map((id) => `'${id}'::uuid`).join(',');
  trace.push({
    sqlOrders: JSON.parse(
      sql(
        'sales',
        `SELECT json_agg(json_build_object('id',id,'key',"idempotencyKey",'status',status,'createdAt',"createdAt",'expiresAt',"expiresAt")) FROM sales."OnlineOrder" WHERE id IN (${ids});`,
      ),
    ),
  });
} catch (e) {
  error = e;
  trace.push({ error: String(e) });
} finally {
  for (const a of orders.values()) {
    try {
      const current = await data(a.id);
      if (!['PENDING', 'AWAITING_PAYMENT'].includes(current.status)) {
        trace.push({ cleanup: a.id, status: current.status });
        continue;
      }
      for (let retry = 0; retry < 4; retry++) {
        const r = await page.request.post(base + '/api/shop/orders/' + a.id + '/cancel', {
          headers: { Authorization: a.auth },
        });
        if (r.status() === 429) {
          console.log('Waiting for checkout rate-limit window before test cleanup');
          await new Promise((resolve) => setTimeout(resolve, 20000));
          continue;
        }
        assert(r.ok());
        trace.push({ cleanup: a.id, http: r.status(), status: (await r.json()).status });
        break;
      }
      assert.equal((await data(a.id)).status, 'CANCELLED', 'test order cleanup');
    } catch (e) {
      error ??= e;
      trace.push({ cleanupError: String(e) });
    }
  }
  writeFileSync(folder + '/full-private.json', JSON.stringify([...orders.values()], null, 2), {
    mode: 0o600,
  });
  writeFileSync(
    publicOut + '/results.json',
    JSON.stringify({ base, status: error ? 'FAIL' : 'PASS', trace }, null, 2),
  );
  console.log(JSON.stringify({ base, status: error ? 'FAIL' : 'PASS', trace }, null, 2));
  await browser.close();
}
if (error) throw error;
