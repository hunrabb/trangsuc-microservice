/** Non-destructive development seed. Writes through service APIs; SQL is read-only. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'DEMO26';
const manifestPath = resolve(ROOT, 'secrets/demo-seed/manifest.json');
const base = 'http://localhost:8081';
const managerEmail = process.env.SEED_MANAGER_EMAIL?.trim().toLowerCase();
const branches = [
  { key: 'HN', name: 'Trang sức Hà Nội (Demo)', address: 'Cầu Giấy, Hà Nội — địa chỉ mẫu' },
  { key: 'HCM', name: 'Trang sức TP.HCM (Demo)', address: 'Quận 1, TP.HCM — địa chỉ mẫu' },
  { key: 'DN', name: 'Trang sức Đà Nẵng (Demo)', address: 'Hải Châu, Đà Nẵng — địa chỉ mẫu' },
];
const metals = [
  {
    key: 'AU9999',
    name: 'Vàng 9999 (Demo)',
    kind: 'GOLD',
    buy: '8500000.00',
    sell: '9000000.00',
    purity: '999.9',
  },
  {
    key: 'AU750',
    name: 'Vàng 18K (Demo)',
    kind: 'GOLD',
    buy: '6000000.00',
    sell: '6500000.00',
    purity: '750',
  },
  {
    key: 'AU585',
    name: 'Vàng 14K (Demo)',
    kind: 'GOLD',
    buy: '4500000.00',
    sell: '5000000.00',
    purity: '585',
  },
  {
    key: 'AG925',
    name: 'Bạc 925 (Demo)',
    kind: 'SILVER',
    buy: '80000.00',
    sell: '120000.00',
    purity: '925',
  },
];
const products = [
  {
    key: 'NHAN24',
    name: 'Nhẫn trơn vàng 9999',
    category: 'Nhẫn',
    metal: 'AU9999',
    weight: '1.0000',
    labor: '250000.00',
    cost: '8750000.00',
  },
  {
    key: 'NHAN18',
    name: 'Nhẫn hoa vàng 18K',
    category: 'Nhẫn',
    metal: 'AU750',
    weight: '0.8000',
    labor: '450000.00',
    cost: '5250000.00',
  },
  {
    key: 'DAY18',
    name: 'Dây chuyền vàng 18K',
    category: 'Dây chuyền',
    metal: 'AU750',
    weight: '2.0000',
    labor: '650000.00',
    cost: '12650000.00',
  },
  {
    key: 'LAC14',
    name: 'Lắc tay vàng 14K',
    category: 'Lắc tay',
    metal: 'AU585',
    weight: '1.5000',
    labor: '500000.00',
    cost: '7250000.00',
  },
  {
    key: 'NHANBAC',
    name: 'Nhẫn bạc 925 tối giản',
    category: 'Nhẫn',
    metal: 'AG925',
    weight: '1.0000',
    labor: '180000.00',
    cost: '260000.00',
  },
  {
    key: 'LACBAC',
    name: 'Lắc tay bạc 925',
    category: 'Lắc tay',
    metal: 'AG925',
    weight: '2.0000',
    labor: '250000.00',
    cost: '410000.00',
  },
];
if (process.argv.includes('--plan')) {
  console.log(
    JSON.stringify(
      {
        prefix: PREFIX,
        branches: 3,
        metals: 4,
        categories: 3,
        products: 6,
        variants: 6,
        receiptItems: 108,
        posOrders: 9,
        onlineOrders: 4,
        customerAccounts: 3,
        buybackIntakes: 6,
        destructive: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
let s;
const secret = () => `Demo-${randomBytes(18).toString('base64url')}-aA1`;
function save() {
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(manifestPath), 0o700);
  const tmp = manifestPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, manifestPath);
}
function docker(args, input, encoding = 'utf8') {
  return execFileSync('docker', args, {
    input,
    encoding,
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
}
function sql(service, statement) {
  return docker(
    [
      'exec',
      '-i',
      `jewelry-${service}-postgres-1`,
      'sh',
      '-c',
      'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At',
    ],
    statement,
  ).trim();
}
const uuid = (value) => {
  assert.match(value, /^[0-9a-f-]{36}$/i);
  return value;
};
const tokens = {};
async function api(
  path,
  { method = 'GET', body, as = 'admin', key, capability, status, allow404 = false } = {},
) {
  const headers = {
    accept: 'application/json',
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(tokens[as] ? { authorization: `Bearer ${tokens[as]}` } : {}),
  };
  if (capability)
    headers[tokens[as] ? 'x-checkout-authorization' : 'authorization'] = `Checkout ${capability}`;
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (allow404 && response.status === 404) return null;
  if (!response.ok || (status && response.status !== status))
    throw new Error(
      `${method} ${path}: HTTP ${response.status} ${data?.code ?? ''} ${data?.message ?? ''}`,
    );
  return data;
}
async function poll(label, fn, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error('Timed out: ' + label);
}
async function login(alias) {
  const account = s[alias];
  const session = await api('/api/auth/login', {
    method: 'POST',
    as: 'none',
    body: { email: account.email, password: account.password },
  });
  tokens[alias] = session.accessToken;
  account.id = session.user.id;
  save();
}
async function all(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const result = await api(`${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=100`);
    out.push(...result.items);
    if (out.length >= result.total || !result.items.length) return out;
  }
}
async function preflight() {
  for (const service of ['auth', 'sales', 'inventory', 'report']) {
    const info = JSON.parse(docker(['inspect', `jewelry-${service}-1`]))[0];
    assert.equal(info.Config.Labels['com.docker.compose.project'], 'jewelry');
    assert.equal(info.State.Health.Status, 'healthy');
    const env = info.Config.Env.find((v) => v.startsWith('DATABASE_URL='));
    const url = new URL(env.slice(13));
    assert.equal(url.hostname, `${service}-postgres`);
    assert.equal(url.pathname, `/${service}_db`);
  }
  if (!s.backupDirectory) {
    const folder = resolve(ROOT, `secrets/backups/system-seed-${Date.now()}`);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    for (const service of ['auth', 'inventory', 'sales', 'report']) {
      const dump = docker(
        [
          'exec',
          `jewelry-${service}-postgres-1`,
          'sh',
          '-c',
          'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc',
        ],
        undefined,
        null,
      );
      writeFileSync(resolve(folder, `${service}.dump`), dump, { mode: 0o600 });
      docker(['exec', '-i', `jewelry-${service}-postgres-1`, 'pg_restore', '--list'], dump);
    }
    s.backupDirectory = folder;
    save();
  }
  console.log('PASS preflight: correct development databases; four readable backups retained');
}
async function seedAuth() {
  const count = sql(
    'auth',
    `SELECT count(*) FROM auth."User" WHERE email='admin.demo@example.test';`,
  );
  if (count === '0')
    docker(
      [
        'exec',
        '-i',
        'jewelry-auth-1',
        'node',
        'dist/cli/admin-create.js',
        '--email',
        s.admin.email,
        '--full-name',
        'Quản trị hệ thống (Demo)',
      ],
      s.admin.password + '\n',
    );
  await login('admin');
  let users = await all('/api/admin/auth/users');
  let reviewer = users.find((u) => u.email === s.reviewer.email);
  if (!reviewer)
    reviewer = await api('/api/admin/auth/users', {
      method: 'POST',
      body: {
        email: s.reviewer.email,
        fullName: 'Kiểm soát giao dịch (Demo)',
        password: s.reviewer.password,
        assignments: [{ branchId: null, role: 'ADMIN' }],
      },
    });
  s.reviewer.id = reviewer.id;
  save();
  await login('reviewer');
  const existing = await all('/api/admin/auth/branches');
  for (const branch of branches) {
    const code = `${PREFIX}-${branch.key}`;
    s.branches[branch.key] =
      existing.find((b) => b.code === code) ??
      (await api('/api/admin/auth/branches', {
        method: 'POST',
        body: { code, name: branch.name, address: branch.address },
      }));
    save();
    const id = await poll('branch event creates warehouse', () =>
      sql(
        'inventory',
        `SELECT id FROM inventory."Warehouse" WHERE "branchId"='${uuid(s.branches[branch.key].id)}'::uuid;`,
      ),
    );
    s.branches[branch.key].warehouseId = id;
    save();
  }
  const realEmail = managerEmail ?? s.managerEmail ?? 'manager.demo@example.test';
  s.managerEmail = realEmail;
  save();
  const employees = [
    {
      email: realEmail,
      fullName: 'Quản lý chuỗi demo',
      assignments: branches.map((b) => ({ branchId: s.branches[b.key].id, role: 'MANAGER' })),
    },
    ...branches.map((b) => ({
      email: `staff.${b.key.toLowerCase()}.demo@example.test`,
      fullName: `Nhân viên ${b.key} (Demo)`,
      assignments: [{ branchId: s.branches[b.key].id, role: 'STAFF' }],
    })),
  ];
  users = await all('/api/admin/auth/users');
  for (const employee of employees) {
    let found = users.find((u) => u.email === employee.email);
    if (!found) found = await api('/api/admin/auth/users', { method: 'POST', body: employee });
    else if (!found.branches.some((b) => b.role === 'ADMIN')) {
      const assignments = [...found.branches];
      for (const wanted of employee.assignments)
        if (!assignments.some((a) => a.branchId === wanted.branchId)) assignments.push(wanted);
      if (assignments.length !== found.branches.length)
        found = await api(`/api/admin/auth/users/${found.id}/assignments`, {
          method: 'PUT',
          body: { assignments },
        });
    }
    s.employees[employee.email] = { id: found.id, status: found.status, branches: found.branches };
    save();
  }
  console.log(
    'PASS Auth: two demo admins, three demo branches, manager and branch staff (existing roles preserved)',
  );
}
async function seedInventory() {
  const im = '/api/admin/inventory';
  const existingMetals = await api(im + '/metals');
  for (const metal of metals) {
    const m =
      existingMetals.find((m) => m.code === `${PREFIX}-${metal.key}`) ??
      (await api(im + '/metals', {
        method: 'POST',
        body: { code: `${PREFIX}-${metal.key}`, name: metal.name, kind: metal.kind },
      }));
    s.metals[metal.key] = m;
    save();
    const priceHistory = await api(`${im}/metals/${m.id}/prices?pageSize=1`);
    if (!priceHistory.items.length)
      await api(`${im}/metals/${m.id}/prices`, {
        method: 'POST',
        body: { buyPrice: metal.buy, sellPrice: metal.sell },
      });
  }
  const categories = await api(im + '/categories');
  for (const name of new Set(products.map((p) => p.category)))
    s.categories[name] =
      categories.find((c) => c.name === `${name} (Demo)`) ??
      (await api(im + '/categories', { method: 'POST', body: { name: `${name} (Demo)` } }));
  save();
  const allProducts = await all(im + '/products'),
    allVariants = await all(im + '/variants');
  for (const product of products) {
    let p =
      allProducts.find((p) => p.name === product.name + ' (Demo)') ??
      (await api(im + '/products', {
        method: 'POST',
        body: {
          categoryId: s.categories[product.category].id,
          name: product.name + ' (Demo)',
          description:
            'DEMO26 — Dữ liệu mẫu để thử giao diện và nghiệp vụ. Giá minh hoạ, không phải báo giá thị trường.',
        },
      }));
    if (!p.publishedOnline)
      p = await api(`${im}/products/${p.id}`, {
        method: 'PATCH',
        body: { version: p.version, publishedOnline: true },
      });
    const v =
      allVariants.find((v) => v.sku === `${PREFIX}-${product.key}`) ??
      (await api(im + '/variants', {
        method: 'POST',
        body: {
          productId: p.id,
          metalId: s.metals[product.metal].id,
          sku: `${PREFIX}-${product.key}`,
          name: product.name,
          defaultLaborFee: product.labor,
        },
      }));
    s.products[product.key] = { ...p, variantId: v.id };
    save();
  }
  for (const branch of branches) {
    const b = s.branches[branch.key];
    await api(`${im}/online-catalog/warehouses/${b.warehouseId}`, {
      method: 'PUT',
      body: { acceptsOnlineOrders: true },
    });
    const note = `${PREFIX} — Phiếu nhập ban đầu ${branch.key}`;
    let receipt = s.receipts[branch.key]
      ? await api(`${im}/receipts/${s.receipts[branch.key].id}`)
      : (await all(`${im}/receipts?branchId=${b.id}`)).find((r) => r.note === note);
    if (!receipt)
      receipt = await api(im + '/receipts', { method: 'POST', body: { branchId: b.id, note } });
    s.receipts[branch.key] = { id: receipt.id, code: receipt.code };
    save();
    if (receipt.status === 'DRAFT') {
      for (const product of products)
        for (let n = 1; n <= 6; n++) {
          const tagCode = `${PREFIX}-${branch.key}-${product.key}-${String(n).padStart(2, '0')}`;
          if (!receipt.lines.some((l) => l.tagCode === tagCode))
            receipt = await api(`${im}/receipts/${receipt.id}/lines`, {
              method: 'POST',
              body: {
                variantId: s.products[product.key].variantId,
                tagCode,
                weight: product.weight,
                laborFee: product.labor,
                costPrice: product.cost,
              },
            });
        }
      assert.equal(receipt.lines.length, 36, 'Refuse approval of modified demo receipt');
      await api(`${im}/receipts/${receipt.id}/approve`, {
        method: 'POST',
        body: { version: receipt.version },
      });
    }
    for (const product of products)
      await api(
        `${im}/online-catalog/warehouses/${b.warehouseId}/buffers/${s.products[product.key].variantId}`,
        { method: 'PUT', body: { quantity: 1 } },
      );
  }
  await poll('Storefront has six seeded products', async () => {
    const p = await api('/api/shop/products?pageSize=50', { as: 'none' });
    return (
      p.items.filter((p) => p.name.endsWith('(Demo)')).length === 6 &&
      p.items.some((p) => p.inStock)
    );
  });
  console.log(
    'PASS Inventory/Storefront: 4 metals with prices, 6 published products, 108 received units, 3 online warehouses',
  );
}
async function seedCustomersAndPos() {
  for (let n = 1; n <= 6; n++) {
    const key = String(n),
      name =
        [
          'Nguyễn Minh Anh',
          'Trần Hoàng Nam',
          'Lê Thu Hà',
          'Phạm Đức Minh',
          'Đỗ Ngọc Linh',
          'Vũ Thanh Sơn',
        ][n - 1] + ' (Demo)';
    const customer = await api('/api/pos/customers', {
      method: 'POST',
      body: { branchId: s.branches.HN.id, phone: `099000010${n}`, name },
    });
    assert.equal(
      customer.name,
      name,
      'Demo phone collides with an existing customer; refusing to alter it',
    );
    s.customers[key] = customer;
    save();
  }
  for (let i = 0; i < branches.length; i++)
    for (const [j, target] of ['COMPLETED', 'CANCELLED', 'PENDING_PAYMENT'].entries()) {
      const branch = branches[i],
        alias = `${branch.key}-${target}`,
        key = `${PREFIX}-POS-${alias}`;
      let order = await api(`/api/pos/orders/by-key/${key}`, { allow404: true });
      if (!order)
        order = await api('/api/pos/orders', {
          method: 'POST',
          key,
          body: {
            branchId: s.branches[branch.key].id,
            tagCodes: [`${PREFIX}-${branch.key}-${products[j].key}-01`],
            customerId: s.customers[String(i + 1)].id,
          },
        });
      if (order.status === 'PENDING_PAYMENT' && target === 'COMPLETED')
        order = await api(`/api/pos/orders/${order.id}/confirm-payment`, { method: 'POST' });
      if (order.status === 'PENDING_PAYMENT' && target === 'CANCELLED')
        order = await api(`/api/pos/orders/${order.id}/cancel`, { method: 'POST' });
      assert.equal(order.status, target);
      s.pos[alias] = { id: order.id, code: order.code, status: order.status, key };
      save();
    }
  console.log('PASS Sales POS: 6 customers; 3 completed, 3 cancelled and 3 pending POS invoices');
}
async function seedOnline() {
  for (const alias of ['a', 'b', 'c']) {
    const account = s.onlineCustomers[alias] ?? {
      email: `khach.${alias}.demo@example.test`,
      password: secret(),
      fullName: `Khách hàng ${alias.toUpperCase()} (Demo)`,
    };
    s.onlineCustomers[alias] = account;
    save();
    const session = account.registered
      ? await api('/api/shop/auth/login', {
          method: 'POST',
          as: 'none',
          body: { email: account.email, password: account.password },
        })
      : await api('/api/shop/auth/register', {
          method: 'POST',
          as: 'none',
          body: { email: account.email, password: account.password, fullName: account.fullName },
        });
    account.registered = true;
    account.id = session.user.id;
    tokens[`customer-${alias}`] = session.accessToken;
    save();
  }
  const examples = [
    ['a', 'CONFIRMED', 'NHANBAC'],
    ['a', 'AWAITING_PAYMENT', 'LACBAC'],
    ['b', 'CANCELLED', 'NHAN18'],
    ['guest', 'AWAITING_PAYMENT', 'DAY18'],
  ];
  for (const [owner, target, product] of examples) {
    const alias = `${owner}-${target}`;
    const entry = s.online[alias] ?? {
      key: `${PREFIX}-WEB-${alias}`,
      capability: randomBytes(32).toString('hex'),
    };
    s.online[alias] = entry;
    save();
    const as = owner === 'guest' ? 'none' : `customer-${owner}`,
      path = owner === 'guest' ? '/api/shop/orders' : '/api/shop/my-orders';
    const read = () =>
      api(`${path}/${entry.id}`, {
        as,
        capability: owner === 'guest' ? entry.capability : undefined,
      });
    let order;
    if (!entry.id) {
      order = await api('/api/shop/orders/by-key', {
        as: 'none',
        capability: entry.capability,
        key: entry.key,
        allow404: true,
      });
      if (!order)
        order = await api(path, {
          method: 'POST',
          as,
          key: entry.key,
          capability: entry.capability,
          body: {
            items: [{ variantId: s.products[product].variantId, quantity: 1 }],
            recipientName: `Khách demo ${owner}`,
            recipientPhone: '0990000199',
            shippingAddress: 'DEMO26 — Địa chỉ giao hàng mẫu, không thực hiện giao hàng',
            email: owner === 'guest' ? 'guest.demo@example.test' : s.onlineCustomers[owner].email,
          },
        });
      entry.id = order.id;
      entry.code = order.code;
      save();
    }
    order = await poll('online order leaves PENDING', async () => {
      const o = await read();
      return o.status !== 'PENDING' && o;
    });
    if (target === 'CANCELLED' && order.status === 'AWAITING_PAYMENT')
      order = await api(`${path}/${entry.id}/cancel`, {
        method: 'POST',
        as,
        capability: owner === 'guest' ? entry.capability : undefined,
      });
    if (target === 'CONFIRMED' && order.status === 'AWAITING_PAYMENT') {
      const branchId = sql(
        'sales',
        `SELECT "branchId" FROM sales."OnlineOrder" WHERE id='${uuid(entry.id)}'::uuid;`,
      );
      await api(
        `/api/admin/sales/branches/${branchId}/online-orders/${entry.id}/payments/confirm`,
        {
          method: 'POST',
          key: `${PREFIX}-PAY-${alias}`,
          body: {
            bankTxnRef: `${PREFIX}-SIMULATED-PAY-${alias}`,
            amount: order.total,
            currency: 'VND',
            evidenceRef:
              'DEMO ONLY — simulated payment fixture; no bank transaction or actual funds',
          },
        },
      );
      order = await poll('Inventory confirms seeded online payment', async () => {
        const o = await read();
        return o.status === 'CONFIRMED' && o;
      });
    }
    // Unpaid demo orders naturally expire. A rerun preserves their history instead of manufacturing a replacement.
    if (order.status !== target)
      assert.ok(
        target === 'AWAITING_PAYMENT' && order.status === 'CANCELLED',
        'Unexpected online order lifecycle: ' + order.status,
      );
    entry.status = order.status;
    save();
  }
  console.log(
    'PASS customer accounts/orders: A has paid and pending examples; B cancelled; C empty; guest capability retained',
  );
}
async function seedBuybacks() {
  const metal = s.metals.AU9999;
  for (const branch of branches) {
    const path = `/api/admin/sales/branches/${s.branches[branch.key].id}/buybacks`;
    const policies = await api(path + '/price-policies');
    let policy = policies.find((p) => p.label === `${PREFIX} — Vàng 9999`);
    if (!policy)
      policy = await api(path + '/price-policies', {
        method: 'POST',
        key: `${PREFIX}-POLICY-${branch.key}`,
        body: {
          metalId: metal.id,
          metalKind: 'GOLD',
          purityPerMille: '999.9',
          label: `${PREFIX} — Vàng 9999`,
          deductionVndPerItem: '50000.00',
          reason: 'DEMO ONLY — chính sách thu mua mẫu',
        },
      });
    s.policies[branch.key] = policy;
    save();
  }
  const cases = [
    ['HN', 'DRAFT'],
    ['HN', 'PENDING_APPRAISAL'],
    ['HCM', 'APPRAISED'],
    ['HCM', 'SETTLED'],
    ['DN', 'REJECTED'],
    ['DN', 'CANCELLED'],
  ];
  for (const [branch, target] of cases) {
    const alias = `${branch}-${target}`,
      path = `/api/admin/sales/branches/${s.branches[branch].id}/buybacks`,
      key = `${PREFIX}-BB-${alias}`;
    if (s.buybacks[alias]?.done) continue;
    let intake = await api(path + '/by-key', { key, allow404: true });
    if (!intake)
      intake = await api(path, {
        method: 'POST',
        key,
        body: {
          customer: { customerId: s.customers['4'].id },
          notes: `${PREFIX} — Hồ sơ demo ${target}; không có tiền/hàng thật`,
          items: [
            {
              source: 'EXTERNAL',
              referenceTagCode: null,
              assetKind: 'GOLD',
              description: 'Nhẫn vàng cũ (Demo)',
              condition: 'Dữ liệu minh hoạ, cần kiểm định',
              declaredWeight: '1.0000',
              initialMeasuredWeight: '1.0000',
              declaredPurity: '9999',
              notes: 'DEMO ONLY',
            },
          ],
        },
      });
    const id = intake.id;
    s.buybacks[alias] = { ...s.buybacks[alias], id, code: intake.code };
    save();
    intake = await api(`${path}/${id}`);
    const refresh = () => api(`${path}/${id}`);
    if (target === 'CANCELLED' && intake.status === 'DRAFT')
      intake = await api(`${path}/${id}/cancel`, {
        method: 'POST',
        body: { version: intake.version, reason: 'DEMO ONLY — khách không tiếp tục giao dịch mẫu' },
      });
    if (!['DRAFT', 'CANCELLED'].includes(target)) {
      if (intake.status === 'DRAFT')
        intake = await api(`${path}/${id}/submit`, {
          method: 'POST',
          body: { version: intake.version },
        });
      if (target !== 'PENDING_APPRAISAL') {
        if (intake.status === 'PENDING_APPRAISAL') {
          await api(`${path}/${id}/items/${intake.items[0].id}/appraisal`, {
            method: 'PUT',
            key: key + '-APPRAISE',
            body: {
              version: intake.version,
              measuredWeight: '1.0000',
              acceptedWeight: '0.9800',
              metalId: metal.id,
              metalKind: 'GOLD',
              purityPerMille: '999.9',
              condition: 'Đã kiểm định mẫu demo',
              notes: 'DEMO ONLY — kết quả minh hoạ',
            },
          });
          intake = await refresh();
        }
        if (target !== 'APPRAISED') {
          let quotes = await api(`${path}/${id}/quotes`);
          let quote = quotes.quotes.find((q) =>
            ['QUOTED', 'APPROVED', 'REJECTED'].includes(q.status),
          );
          if (!quote) {
            quote = await api(`${path}/${id}/quotes`, {
              method: 'POST',
              key: key + '-QUOTE',
              body: {
                version: intake.version,
                items: [
                  {
                    itemId: intake.items[0].id,
                    policyId: s.policies[branch].id,
                    policyVersion: s.policies[branch].version,
                  },
                ],
              },
            });
            intake = await refresh();
          }
          if (quote.status === 'QUOTED') {
            await api(
              `${path}/${id}/quotes/${quote.id}/${target === 'REJECTED' ? 'reject' : 'approve'}`,
              {
                method: 'POST',
                as: 'reviewer',
                key: key + '-DECIDE',
                body: {
                  version: intake.version,
                  ...(target === 'REJECTED'
                    ? { reason: 'DEMO ONLY — khách không đồng ý giá mẫu' }
                    : {}),
                },
              },
            );
            intake = await refresh();
          }
          if (target === 'SETTLED') {
            let settlement = s.buybacks[alias].settlementId
              ? await api(`${path}/${id}/settlements`)
              : null;
            if (!settlement)
              settlement = await api(`${path}/${id}/settlements`, {
                method: 'POST',
                key: key + '-SETTLE',
                body: { version: intake.version, method: 'CASH' },
              });
            s.buybacks[alias].settlementId = settlement.id;
            save();
            if (settlement.status === 'AWAITING_PAYMENT')
              settlement = await api(`${path}/${id}/settlements/${settlement.id}/payment`, {
                method: 'POST',
                key: key + '-RECORD',
                body: {
                  version: settlement.version,
                  reference: key + '-DEMO-CASH',
                  evidence: 'DEMO ONLY — simulated cash payout; no actual funds',
                },
              });
            if (settlement.status === 'PAYMENT_RECORDED')
              settlement = await api(`${path}/${id}/settlements/${settlement.id}/confirm`, {
                method: 'POST',
                as: 'reviewer',
                key: key + '-CONFIRM',
                body: {
                  version: settlement.version,
                  verificationReference: key + '-DEMO-VERIFY',
                  note: 'DEMO ONLY — simulated verification by separate demo reviewer',
                },
              });
            await poll('buyback settlement and Inventory receipt', async () => {
              const list = await api(`${path}/${id}/settlements`);
              return list?.id === settlement.id && list.status === 'SETTLED';
            });
          }
        }
      }
    }
    s.buybacks[alias].done = true;
    s.buybacks[alias].target = target;
    save();
  }
  console.log(
    'PASS Buyback: draft, appraisal queue, appraised, rejected, cancelled and a separately approved/settled demo',
  );
}
async function verify() {
  for (const branch of branches) {
    const b = s.branches[branch.key];
    await poll(
      'Report receives completed POS sale',
      () =>
        sql(
          'report',
          `SELECT count(*) FROM report."OrderRevenue" WHERE "orderId"='${uuid(s.pos[branch.key + '-COMPLETED'].id)}'::uuid AND status='PAID';`,
        ) === '1',
    );
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    await api(`/api/admin/reports/daily?from=${today}&to=${today}&branchId=${b.id}`);
  }
  const settledId = uuid(s.buybacks['HCM-SETTLED'].settlementId);
  await poll(
    'Report reconciles settled buyback and received assets',
    () =>
      sql(
        'report',
        `SELECT count(*) FROM report."BuybackSettlementFact" s JOIN report."BuybackStockFact" i USING ("settlementId") WHERE s."settlementId"='${settledId}'::uuid;`,
      ) === '1',
  );
  const owned = await api('/api/shop/my-orders', { as: 'customer-a' });
  assert.equal(owned.total, 2);
  const empty = await api('/api/shop/my-orders', { as: 'customer-c' });
  assert.equal(empty.total, 0);
  const catalog = await api('/api/shop/products?pageSize=50', { as: 'none' });
  assert.ok(catalog.items.filter((p) => p.name.endsWith('(Demo)')).length >= 6);
  const accounts = [
    'DEVELOPMENT DEMO ACCOUNTS — keep this file private',
    'Backoffice: http://localhost:8080/ — choose email/password admin login',
    ...['admin', 'reviewer'].map((alias) => `${alias}: ${s[alias].email} | ${s[alias].password}`),
    `Manager (Google): ${s.managerEmail} — select a (Demo) branch`,
    'Storefront: http://localhost:8081/tai-khoan/don-hang',
    ...Object.entries(s.onlineCustomers).map(
      ([alias, a]) => `customer-${alias}: ${a.email} | ${a.password}`,
    ),
  ];
  writeFileSync(resolve(dirname(manifestPath), 'accounts.txt'), accounts.join('\n') + '\n', {
    mode: 0o600,
  });
  s.lastVerifiedAt = new Date().toISOString();
  save();
  console.log(
    'PASS final verification: Report projections, six Storefront products, account order isolation and empty account',
  );
  console.log(`Credentials and IDs saved privately: ${manifestPath}`);
}
async function main() {
  s = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {
        prefix: PREFIX,
        admin: { email: 'admin.demo@example.test', password: secret() },
        reviewer: { email: 'reviewer.demo@example.test', password: secret() },
        branches: {},
        employees: {},
        metals: {},
        categories: {},
        products: {},
        receipts: {},
        customers: {},
        pos: {},
        onlineCustomers: {},
        online: {},
        policies: {},
        buybacks: {},
      };
  assert.equal(s.prefix, PREFIX);
  save();
  await preflight();
  await seedAuth();
  await seedInventory();
  await seedCustomersAndPos();
  await seedOnline();
  await seedBuybacks();
  await verify();
}
main().catch((error) => {
  console.error('SEED FAILED: ' + error.message);
  process.exitCode = 1;
});
