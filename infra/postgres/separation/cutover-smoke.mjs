// Minimal development cutover smoke. Only run with the legacy application roles frozen,
// the four new jewelry DB volumes, and Gateway bound to 127.0.0.1:13000.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = 'http://127.0.0.1:13000';
const services = ['auth', 'inventory', 'sales', 'report'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let stage = 'preflight';
let adminId;
let token;
let branchId;
let failed = false;

function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 45_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.slice(-400)}`);
  return result.stdout.trim();
}
function inspect(name) { return JSON.parse(docker(['inspect', name]))[0]; }
function sql(service, statement, input) {
  const container = service === 'source' ? 'jewelry-postgres-1' : `jewelry-${service}-postgres-1`;
  const database = service === 'source' ? 'jewelry' : `${service}_db`;
  return docker(['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', database, '-At', ...(input ? [] : ['-c', statement])], input ? statement : undefined);
}
function guard() {
  const source = inspect('jewelry-postgres-1');
  assert.equal(source.Config.Labels['com.docker.compose.project'], 'jewelry');
  assert.equal(source.Config.Labels['com.docker.compose.service'], 'postgres');
  assert.equal(source.Mounts.find((mount) => mount.Destination === '/var/lib/postgresql/data')?.Name, 'jewelry_pg_data');
  assert.equal(sql('source', `SELECT count(*) FROM pg_roles WHERE rolname IN
    ('auth_user','inventory_user','sales_user','report_user') AND NOT rolcanlogin`), '4');
  for (const service of services) {
    const database = inspect(`jewelry-${service}-postgres-1`);
    assert.equal(database.Config.Labels['com.docker.compose.project'], 'jewelry');
    assert.equal(database.Config.Labels['com.docker.compose.service'], `${service}-postgres`);
    assert.equal(database.Mounts.find((mount) => mount.Destination === '/var/lib/postgresql/data')?.Name,
      `jewelry_${service}_pg_data`);
    assert.equal(sql(service, 'SELECT current_database()'), `${service}_db`);
    const app = inspect(`jewelry-${service}-1`);
    assert.equal(app.State.Health?.Status, 'healthy');
    const connection = new URL(app.Config.Env.find((entry) => entry.startsWith('DATABASE_URL=')).slice(13));
    assert.equal(connection.hostname, `${service}-postgres`);
    assert.equal(connection.pathname, `/${service}_db`);
  }
  const gateway = inspect('jewelry-gateway-1');
  assert.equal(gateway.State.Health?.Status, 'healthy');
  assert.deepEqual(gateway.NetworkSettings.Ports['3000/tcp'],
    [{ HostIp: '127.0.0.1', HostPort: '13000' }]);
}
async function request(path, { method = 'GET', body, auth = false, key, status = 200 } = {}) {
  const response = await fetch(root + path, {
    method, headers: {
      accept: 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  assert.equal(response.status, status, `${method} ${path}: HTTP ${response.status}, expected ${status}; code=${data?.code ?? data?.error?.code ?? 'unknown'}`);
  return data;
}
async function poll(check, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error('Timed out waiting for cross-service event');
}
async function main() {
  guard();
  console.log('PASS smoke preflight: frozen source, four new DBs, healthy services, loopback Gateway');
  stage = 'Auth password login and role';
  const email = `cutover-smoke-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  const created = docker(['exec', '-i', 'jewelry-auth-1', 'node', 'dist/cli/admin-create.js',
    '--email', email, '--full-name', 'Cutover smoke admin'], `${password}\n`);
  adminId = created.match(/\(([0-9a-f-]{36})\)/i)?.[1];
  assert.match(adminId ?? '', uuid);
  const login = await request('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(login.user.id, adminId);
  token = login.accessToken;
  assert.ok(token);
  const me = await request('/api/auth/me', { auth: true });
  assert.equal(me.id, adminId);
  await request('/api/admin/auth/branches', { auth: true });
  console.log('PASS Auth login, /me and ADMIN branch read');

  stage = 'Auth branch event and Inventory read';
  const branch = await request('/api/admin/auth/branches', { method: 'POST', auth: true,
    status: 201, body: { code: `CUT-${randomUUID().slice(0, 8)}`, name: 'Cutover smoke branch' } });
  branchId = branch.id;
  assert.match(branchId, uuid);
  await poll(() => sql('inventory', `SELECT count(*) FROM inventory."Warehouse" WHERE "branchId"='${branchId}'::uuid`) === '1');
  const eventId = sql('auth', `SELECT id FROM auth."OutboxEvent" WHERE "aggregateId"='${branchId}'::uuid AND "eventType"='branch.created' LIMIT 1`);
  assert.match(eventId, uuid);
  await poll(() => sql('auth', `SELECT status FROM auth."OutboxEvent" WHERE id='${eventId}'::uuid`) === 'PUBLISHED');
  assert.equal(sql('inventory', `SELECT count(*) FROM inventory."ProcessedEvent" WHERE "eventId"='${eventId}'::uuid`), '1');
  await request('/api/admin/inventory/metals', { auth: true });
  await request(`/api/admin/inventory/items?branchId=${branchId}`, { auth: true });
  console.log('PASS Auth branch.created outbox -> Inventory warehouse/ProcessedEvent and Inventory reads');

  stage = 'Sales, public catalog, Report reads and safe POS rejection';
  await request(`/api/admin/sales/branches/${branchId}/buybacks`, { auth: true });
  await request('/api/shop/products');
  const today = new Date().toISOString().slice(0, 10);
  await request(`/api/admin/reports/daily?from=${today}&to=${today}&branchId=${branchId}`, { auth: true });
  await request(`/api/admin/reports/buybacks?from=${today}&to=${today}&branchId=${branchId}`, { auth: true });
  const missing = randomUUID();
  await request(`/api/pos/orders/${missing}`, { auth: true, status: 404 });
  const orderCount = Number(sql('sales', 'SELECT count(*) FROM sales."Order"'));
  const posKey = `CUT-${randomUUID()}`;
  await request('/api/pos/orders', { method: 'POST', auth: true, key: posKey,
    status: 409, body: { branchId, tagCodes: [`CUTOVER-MISSING-${randomUUID()}`] } });
  assert.equal(Number(sql('sales', 'SELECT count(*) FROM sales."Order"')), orderCount + 1);
  const rejected = sql('sales', `SELECT id::text,status::text FROM sales."Order" WHERE "idempotencyKey"='${posKey}'`);
  const [orderId, orderStatus] = rejected.split('|');
  assert.match(orderId, uuid);
  assert.equal(orderStatus, 'CANCELLED');
  assert.equal(sql('sales', `SELECT count(*) FROM sales."OrderItem" WHERE "orderId"='${orderId}'::uuid`), '0');
  assert.equal(sql('inventory', `SELECT count(*) FROM inventory."JewelryItem" WHERE "orderId"='${orderId}'::uuid`), '0');
  await poll(() => sql('report', `SELECT status||'|'||revenue FROM report."OrderRevenue" WHERE "orderId"='${orderId}'::uuid`) === 'CANCELLED|0.00');
  console.log('PASS Sales/Buyback/Report/public catalog reads; missing-stock POS ends CANCELLED with zero sale/revenue');
  console.log(`RESULT PASS minimal cutover smoke; fixture branch=${branchId}`);
}

try {
  await main();
} catch (error) {
  failed = true;
  console.error(`FAIL ${stage}: ${error.message}`);
} finally {
  if (branchId && token) {
    try {
      await request(`/api/admin/auth/branches/${branchId}/deactivate`, { method: 'POST', auth: true });
      console.log('PASS smoke branch deactivated');
    } catch (error) {
      failed = true;
      console.error(`FAIL smoke branch cleanup: ${error.message}`);
    }
  }
  if (adminId) {
    try {
      assert.match(adminId, uuid);
      const auditId = randomUUID();
      sql('auth', `BEGIN;
        UPDATE auth."User" SET status='LOCKED',"passwordHash"=NULL,version=version+1,"updatedAt"=now()
        WHERE id='${adminId}'::uuid;
        UPDATE auth."RefreshToken" SET "revokedAt"=now(),"updatedAt"=now()
        WHERE "userId"='${adminId}'::uuid AND "revokedAt" IS NULL;
        INSERT INTO auth."AuditLog" (id,"actorId",action,"entityType","entityId",data,"correlationId")
        VALUES ('${auditId}'::uuid,NULL,'cutover.smoke_fixture_locked','User','${adminId}'::uuid,
          '{"purpose":"development-cutover-smoke"}'::jsonb,'cutover-smoke');
        COMMIT;`, true);
      assert.equal(sql('auth', `SELECT status FROM auth."User" WHERE id='${adminId}'::uuid`), 'LOCKED');
      console.log('PASS smoke admin locked, password removed and refresh sessions revoked');
    } catch (error) {
      failed = true;
      console.error(`FAIL smoke admin cleanup: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}
