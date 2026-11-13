/* global window, document, innerWidth -- Used only inside Playwright page.evaluate callbacks. */
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const out = fileURLToPath(new URL('./evidence/demo-payment/', import.meta.url));
mkdirSync(out, { recursive: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    await page.goto(
      (process.env.STOREFRONT_TEST_URL || 'http://127.0.0.1:5174') +
        '/test/demo-payment.browser.html',
    );
    await page.getByRole('button', { name: 'Tôi đã chuyển khoản (Demo)', exact: true }).waitFor();
    assert.ok((await page.locator('.demo-payment-amount').innerText()).includes('1.234.567,89'));
    assert.equal(await page.getByRole('img').count(), 1);
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.getByRole('button', { name: 'Tôi đã chuyển khoản (Demo)', exact: true }).click();
    await page
      .getByRole('status')
      .filter({ hasText: 'Đã ghi nhận thao tác mô phỏng trên trang này.' })
      .waitFor();
    assert.equal(await page.evaluate(() => window.testOrder.status), 'AWAITING_PAYMENT');
    assert.equal(requests.filter((url) => url.includes('/api/')).length, 0);
    assert.equal(requests.filter((url) => /payment|confirm/.test(new URL(url).pathname)).length, 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${out}/acknowledged-${width}.png`, fullPage: true });
    await page.evaluate(() => window.renderOrder({ status: 'CONFIRMED' }));
    await page.locator('.demo-payment').waitFor({ state: 'detached' });
    await page.evaluate(() => window.renderOrder({ status: 'AWAITING_PAYMENT' }));
    await page.getByRole('button', { name: 'Tôi đã chuyển khoản (Demo)', exact: true }).waitFor();
    for (const status of [
      'CANCELLED',
      'PAYMENT_PROCESSING',
      'PAYMENT_REVIEW',
      'REFUND_PENDING',
      'PENDING',
    ]) {
      await page.evaluate((status) => window.renderOrder({ status }), status);
      await page.locator('.demo-payment').waitFor({ state: 'detached' });
    }
    results.push({
      width,
      status: 'PASS',
      checks: [
        'demo QR and exact backend amount',
        'local acknowledgement',
        'no API or admin payment request',
        'order status unchanged',
        'backend CONFIRMED hides card',
        'other lifecycle states hide card',
        'no overflow',
      ],
    });
    await context.close();
  }
  writeFileSync(out + '/results.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
