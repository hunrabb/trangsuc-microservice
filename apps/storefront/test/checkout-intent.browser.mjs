import { fileURLToPath } from 'node:url';
if (process.env.RUN_REBUY_DEVELOPMENT !== '1')
  throw new Error(
    'Local development only: creates demo orders and advances expiry for one test reservation. Set RUN_REBUY_DEVELOPMENT=1.',
  );
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const base = process.env.TEST_BASE || 'http://localhost:8081';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const out = fileURLToPath(new URL('./evidence/checkout-intent-p0/', import.meta.url));
mkdirSync(out, { recursive: true });
const privateFolder = fileURLToPath(new URL('../../../secrets/p0-checkout/', import.meta.url));
mkdirSync(privateFolder, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const records = [],
  orders = new Map(),
  cases = {},
  runtimes = [],
  bundles = [];
let current = 'setup';
const jobs = [];
function sql(service, q) {
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
    { input: q, encoding: 'utf8' },
  ).trim();
}
page.on('pageerror', (e) => runtimes.push(String(e)));
page.on('response', (r) => {
  if (new URL(r.url()).pathname.match(/^\/assets\/.*\.js$/))
    bundles.push({ url: r.url(), http: r.status() });
  if (r.url().endsWith('/api/shop/orders') && r.request().method() === 'POST')
    jobs.push(
      (async () => {
        const d = await r.json(),
          h = r.request().headers();
        assert(r.ok());
        orders.set(d.id, {
          id: d.id,
          key: h['idempotency-key'],
          auth: h.authorization,
          body: r.request().postDataJSON(),
        });
        records.push({
          stage: current,
          url: '/dat-hang',
          request: '/api/shop/orders',
          http: r.status(),
          key: h['idempotency-key'],
          returnedId: d.id,
          status: d.status,
        });
      })(),
    );
});
async function wait(f, label, ms = 95000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('timeout ' + label);
}
async function snapshot(label) {
  return {
    label,
    url: page.url(),
    state: await page.evaluate(() => {
      const v = JSON.parse(sessionStorage.getItem('jewelry.storefront.checkout.v1') || 'null');
      return (
        v && {
          activeId: v.activeId,
          attempts: v.attempts.map((a) => ({
            id: a.id,
            key: a.key,
            orderId: a.orderId,
            lastStatus: a.lastStatus,
          })),
        }
      );
    }),
  };
}
async function addFromCatalog() {
  await page.locator('#main-nav').getByRole('link', { name: 'Bộ sưu tập', exact: true }).click();
  await page
    .getByRole('searchbox', { name: 'Tìm tên sản phẩm hoặc mã SKU' })
    .fill('Lắc tay bạc 925');
  await page.getByRole('button', { name: /Áp dụng lựa chọn/ }).click();
  const link = page.locator('.product-card-link').filter({ hasText: 'Lắc tay bạc 925 (Demo)' });
  // Seed catalog's reusable six-units-per-branch product, never mock availability.
  await link.first().click();
  await page.getByRole('button', { name: 'Thêm vào giỏ', exact: true }).click();
  await page.getByRole('link', { name: /Giỏ hàng, / }).click();
  await page.getByRole('link', { name: 'Tiếp tục đặt hàng', exact: true }).click();
  const before = orders.size;
  await page.getByLabel('Họ và tên', { exact: true }).waitFor();
  assert.equal(await page.getByText('Yêu cầu trước đã kết thúc', { exact: true }).count(), 0);
  assert.equal(orders.size, before);
  records.push(await snapshot('catalog-add-checkout-form'));
}
async function submit() {
  const before = orders.size;
  await page.getByLabel('Họ và tên', { exact: true }).fill('P0 checkout integration DEMO');
  await page.getByLabel('Số điện thoại', { exact: true }).fill('0990000999');
  await page
    .getByLabel('Địa chỉ nhận hàng', { exact: true })
    .fill('Địa chỉ kiểm thử development, không giao hàng');
  await page.getByRole('button', { name: 'Gửi yêu cầu đặt hàng', exact: true }).click();
  await page.waitForURL('**/don-hang/*');
  await page.locator('.demo-payment').waitFor();
  await Promise.all(jobs);
  assert.equal(orders.size, before + 1);
  const id = page.url().split('/').pop();
  assert(orders.has(id));
  records.push({
    stage: current,
    navigatedId: id,
    sqlStatus: sql('sales', `SELECT status FROM sales."OnlineOrder" WHERE id='${id}'::uuid;`),
  });
  return id;
}
async function released(id) {
  await wait(
    () =>
      ['RELEASED', 'EXPIRED'].includes(
        sql(
          'inventory',
          `SELECT status FROM inventory."StockReservation" WHERE "orderId"='${id}'::uuid;`,
        ),
      ),
    'release',
  );
}
let error;
try {
  await page.goto(base + '/bo-suu-tap');
  await addFromCatalog();
  const first = await submit();
  await page.getByRole('button', { name: 'Tôi muốn huỷ yêu cầu này', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận huỷ yêu cầu', exact: true }).click();
  await page.getByRole('heading', { name: 'Yêu cầu đặt hàng đã kết thúc', exact: true }).waitFor();
  await released(first);
  current = 'A';
  await addFromCatalog();
  cases.A = { status: 'PASS', checkoutFormWithoutTerminalBanner: true, noExtraStartNewClick: true };
  // Compatibility with sessions persisted by the previous Docker bundle.
  await page.evaluate((first) => {
    const key = 'jewelry.storefront.checkout.v1';
    const saved = JSON.parse(sessionStorage.getItem(key));
    saved.activeId = saved.attempts.find((attempt) => attempt.orderId === first).id;
    sessionStorage.setItem(key, JSON.stringify(saved));
  }, first);
  await page.reload();
  await page.getByLabel('Họ và tên', { exact: true }).waitFor();
  assert.equal((await snapshot('legacy-session-normalized')).state.activeId, null);
  cases.A.legacySessionCompatible = true;
  current = 'C';
  const count = orders.size;
  await page.getByLabel('Họ và tên', { exact: true }).fill('Đang nhập, chưa gửi');
  await page.reload();
  await page.getByLabel('Họ và tên', { exact: true }).waitFor();
  assert.equal(orders.size, count);
  cases.C = { status: 'PASS', formAfterRefresh: true, noImplicitPost: true };
  current = 'D';
  const second = await submit();
  assert.notEqual(second, first);
  assert.notEqual(orders.get(first).key, orders.get(second).key);
  cases.D = {
    status: 'PASS',
    oldOrderId: first,
    newOrderId: second,
    newKey: orders.get(second).key,
  };
  // Only this controlled test's reservation is expired; normal workers handle status transitions.
  assert.equal(
    sql('sales', `SELECT "recipientName" FROM sales."OnlineOrder" WHERE id='${second}'::uuid;`),
    'P0 checkout integration DEMO',
  );
  sql(
    'sales',
    `UPDATE sales."OnlineOrder" SET "deadlineAt"=clock_timestamp()-interval '1 second',"expiresAt"=clock_timestamp()-interval '1 second',"recoveryAfter"=clock_timestamp()-interval '1 second' WHERE id='${second}'::uuid AND status='AWAITING_PAYMENT' AND "recipientName"='P0 checkout integration DEMO';`,
  );
  sql(
    'inventory',
    `UPDATE inventory."StockReservation" SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "orderId"='${second}'::uuid AND status='ACTIVE';`,
  );
  await wait(
    () =>
      sql('sales', `SELECT status FROM sales."OnlineOrder" WHERE id='${second}'::uuid;`) ===
      'CANCELLED',
    'worker expiry',
  );
  await released(second);
  current = 'B';
  await page.reload();
  await page.getByRole('heading', { name: 'Yêu cầu đặt hàng đã kết thúc', exact: true }).waitFor();
  await addFromCatalog();
  cases.B = { status: 'PASS', workerExpiredOrder: second, checkoutFormWithoutTerminalBanner: true };
  current = 'E';
  await page.goBack();
  await page.goForward();
  await page.getByLabel('Họ và tên', { exact: true }).waitFor();
  assert.equal(orders.size, count + 1);
  cases.E = { status: 'PASS', formAfterBackForward: true };
  current = 'F';
  let release;
  const gate = new Promise((r) => (release = r));
  let fetched;
  const arrived = new Promise((r) => (fetched = r));
  await page.route('**/api/shop/orders/' + first, async (route) => {
    const response = await route.fetch();
    fetched();
    await gate;
    try {
      await route.fulfill({ response });
    } catch {
      /* Navigation may abort the original caller. */
    }
  });
  await page.goto(base + '/don-hang/' + first);
  await arrived;
  await addFromCatalog();
  const beforeLate = await snapshot('before-late-response');
  release();
  await page.unroute('**/api/shop/orders/' + first);
  await page.getByLabel('Họ và tên', { exact: true }).waitFor();
  const afterLate = await snapshot('after-late-response');
  assert.equal(afterLate.state.activeId, null);
  assert.equal(beforeLate.state.activeId, null);
  cases.F = { status: 'PASS', delayedRealOrderResponse: true, checkoutNotReactivated: true };
  current = 'H';
  await page.goto(base + '/don-hang/' + first);
  await page.getByRole('heading', { name: 'Yêu cầu đặt hàng đã kết thúc', exact: true }).waitFor();
  await page.goto(base + '/dat-hang');
  await page.getByLabel('Họ và tên', { exact: true }).waitFor();
  assert.equal((await snapshot('history-retained')).state.activeId, null);
  cases.H = { status: 'PASS', historicOrderReadable: true, formRemainsNew: true };
  // Submit after late/history callbacks: proves they cannot silently redirect a later POST.
  current = 'D-after-F-H';
  const third = await submit();
  assert.notEqual(third, second);
  assert.notEqual(orders.get(third).key, orders.get(second).key);
  const expiry = sql(
    'sales',
    `SELECT extract(epoch from ("expiresAt"-clock_timestamp()))::int FROM sales."OnlineOrder" WHERE id='${third}'::uuid;`,
  );
  assert(+expiry > 1680);
  await page.screenshot({ path: out + '/new-payment.png', fullPage: true });
  current = 'G';
  await page.getByRole('link', { name: /Giỏ hàng, / }).click();
  await page.locator('.cart-line').waitFor();
  const buttons = page.getByRole('button', { name: /^Bỏ / });
  while (await buttons.count()) await buttons.first().click();
  await page.goto(base + '/dat-hang');
  await page.getByRole('heading', { name: 'Bạn chưa có sản phẩm để đặt', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('heading', { name: 'Yêu cầu trước đã kết thúc', exact: true }).count(),
    0,
  );
  cases.G = { status: 'PASS', emptyCartNotice: true };
  const workers = await page.evaluate(async () =>
    'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  );
  assert.equal(workers, 0);
  assert.deepEqual(runtimes, []);
  if (!base.includes(':5174')) assert(bundles.length);
  records.push({
    verification: {
      bundles,
      runtimeErrors: runtimes,
      serviceWorkers: workers,
      postCount: orders.size,
    },
  });
} catch (e) {
  error = e;
  records.push({ error: String(e), current });
} finally {
  await Promise.allSettled(jobs);
  for (const a of orders.values()) {
    for (let retry = 0; retry < 4; retry++) {
      const r = await page.request.get(base + '/api/shop/orders/' + a.id, {
        headers: { Authorization: a.auth },
      });
      const d = await r.json();
      if (!['PENDING', 'AWAITING_PAYMENT'].includes(d.status)) break;
      const cancel = await page.request.post(base + '/api/shop/orders/' + a.id + '/cancel', {
        headers: { Authorization: a.auth },
      });
      if (cancel.status() === 429) {
        console.log('Waiting for checkout rate limit before cleanup');
        await new Promise((r) => setTimeout(r, 20000));
        continue;
      }
      assert(cancel.ok());
      await released(a.id);
      break;
    }
  }
  writeFileSync(privateFolder + '/orders.json', JSON.stringify([...orders.values()], null, 2), {
    mode: 0o600,
  });
  writeFileSync(
    out + '/results.json',
    JSON.stringify({ base, status: error ? 'FAIL' : 'PASS', cases, records }, null, 2),
  );
  console.log(JSON.stringify({ base, status: error ? 'FAIL' : 'PASS', cases, records }, null, 2));
  await browser.close();
}
if (error) throw error;
