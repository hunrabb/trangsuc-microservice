/** Import the reviewed Laragon catalog into development through service APIs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const products = JSON.parse(readFileSync(resolve(root, 'scripts/data/legacy-products.json')));
const demo = JSON.parse(readFileSync(resolve(root, 'secrets/demo-seed/manifest.json')));
const folder = resolve(root, 'secrets/manager-course-import');
mkdirSync(folder, { recursive: true, mode: 0o700 });
const manifest = resolve(folder, 'manifest.json');
const state = existsSync(manifest)
  ? JSON.parse(readFileSync(manifest))
  : { products: {}, receipts: {} };
function save() {
  writeFileSync(manifest + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(manifest + '.tmp', manifest);
}
function docker(args, input) {
  return execFileSync('docker', args, { input, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
}
for (const service of ['auth', 'inventory', 'sales', 'report']) {
  const info = JSON.parse(docker(['inspect', `jewelry-${service}-1`]))[0];
  assert.equal(info.Config.Labels['com.docker.compose.project'], 'jewelry');
  assert.equal(info.State.Health.Status, 'healthy');
  const url = new URL(info.Config.Env.find((e) => e.startsWith('DATABASE_URL=')).slice(13));
  assert.equal(url.hostname, `${service}-postgres`);
  assert.equal(url.pathname, `/${service}_db`);
}
if (!state.backupDirectory) {
  const backup = resolve(root, `secrets/backups/legacy-catalog-${Date.now()}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const service of ['auth', 'inventory', 'sales', 'report']) {
    const dump = docker([
      'exec',
      `jewelry-${service}-postgres-1`,
      'sh',
      '-c',
      'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc',
    ]);
    writeFileSync(resolve(backup, service + '.dump'), dump, { mode: 0o600 });
    docker(['exec', '-i', `jewelry-${service}-postgres-1`, 'pg_restore', '--list'], dump);
  }
  state.backupDirectory = backup;
  save();
}
const base = 'http://localhost:8081';
let token;
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    signal: AbortSignal.timeout(60000),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function all(path, pageSize = 100) {
  const items = [];
  for (let page = 1; ; page++) {
    const result = await api(
      `${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=${pageSize}`,
    );
    items.push(...result.items);
    if (items.length >= result.total || !result.items.length) return items;
  }
}
token = (
  await api('/api/auth/login', 'POST', { email: demo.admin.email, password: demo.admin.password })
).accessToken;
const im = '/api/admin/inventory';
const categories = await api(im + '/categories');
const existingProducts = await all(im + '/products');
const existingVariants = await all(im + '/variants');
for (const source of products) {
  const sku = 'LAR26-' + source.key;
  const name = `${source.name} — Mẫu ${String(products.indexOf(source) + 1).padStart(2, '0')} (Demo)`;
  const categoryName = `${source.category} (Nhập demo)`;
  let category = categories.find((c) => c.name === categoryName);
  if (!category) {
    category = await api(im + '/categories', 'POST', { name: categoryName });
    categories.push(category);
  }
  const description = 'Mẫu tham khảo từ danh mục cũ. ' + source.notes;
  let product = existingProducts.find((p) => p.name === name);
  if (!product) {
    product = await api(im + '/products', 'POST', { categoryId: category.id, name, description });
    existingProducts.push(product);
  }
  if (product.imageUrl !== source.image || !product.publishedOnline) {
    product = await api(`${im}/products/${product.id}`, 'PATCH', {
      version: product.version,
      imageUrl: source.image,
      publishedOnline: true,
    });
  }
  let variant = existingVariants.find((v) => v.sku === sku);
  if (!variant) {
    variant = await api(im + '/variants', 'POST', {
      productId: product.id,
      metalId: demo.metals[source.metal].id,
      sku,
      name: source.name,
      defaultLaborFee: Number(source.labor).toFixed(2),
    });
    existingVariants.push(variant);
  }
  assert.equal(variant.productId, product.id);
  state.products[source.key] = { id: product.id, variantId: variant.id, image: source.image };
  save();
}
console.log(`PASS imported ${products.length} products with images and unique SKUs`);
for (const [key, branch] of Object.entries(demo.branches)) {
  const note = `LAR26 — Nhập demo từ Laragon ${key}; tồn kho giả lập, không phải tồn nguồn`;
  let receipt = state.receipts[key]
    ? await api(`${im}/receipts/${state.receipts[key].id}`)
    : (await all(`${im}/receipts?branchId=${branch.id}`)).find((r) => r.note === note);
  if (!receipt) receipt = await api(im + '/receipts', 'POST', { branchId: branch.id, note });
  state.receipts[key] = { id: receipt.id, code: receipt.code };
  save();
  if (receipt.status === 'DRAFT') {
    for (const source of products) {
      const metalBuy = { AG925: 80000, AU9999: 8500000 }[source.metal];
      for (let n = 1; n <= 2; n++) {
        const tagCode = `LAR26-${key}-${source.key}-${n}`;
        if (!receipt.lines.some((l) => l.tagCode === tagCode))
          receipt = await api(`${im}/receipts/${receipt.id}/lines`, 'POST', {
            variantId: state.products[source.key].variantId,
            tagCode,
            weight: Number(source.weight).toFixed(4),
            laborFee: Number(source.labor).toFixed(2),
            costPrice: (metalBuy * Number(source.weight) + Number(source.labor)).toFixed(2),
          });
      }
    }
    assert.equal(receipt.lines.length, products.length * 2);
    receipt = await api(`${im}/receipts/${receipt.id}/approve`, 'POST', {
      version: receipt.version,
    });
  }
  assert.equal(receipt.status, 'APPROVED');
  for (const source of products)
    await api(
      `${im}/online-catalog/warehouses/${branch.warehouseId}/buffers/${state.products[source.key].variantId}`,
      'PUT',
      { quantity: 1 },
    );
  console.log(`PASS ${key}: approved receipt with ${receipt.lines.length} items`);
}
let catalog;
for (let attempt = 0; attempt < 50; attempt++) {
  catalog = (await all('/api/shop/products', 50)).filter((p) =>
    Object.values(state.products).some((s) => s.id === p.id),
  );
  if (catalog.length === products.length && catalog.every((p) => p.inStock)) break;
  await new Promise((resolve) => setTimeout(resolve, 1200));
}
assert.equal(catalog.length, products.length);
assert.ok(
  catalog.every((p) => p.inStock),
  'All imported products must be buyable',
);
for (const source of products) {
  const response = await fetch(base + source.image);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type')?.startsWith('image/'));
}
state.result = {
  products: products.length,
  vangbac: 14,
  html: 13,
  receivedItems: products.length * 6,
  images: products.length,
  inStock: catalog.filter((p) => p.inStock).length,
  checkedAt: new Date().toISOString(),
};
save();
console.log('PASS storefront catalog and image HTTP checks:', JSON.stringify(state.result));
