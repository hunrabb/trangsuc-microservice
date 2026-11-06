// Nạp cấu hình RabbitMQ qua management HTTP API. Chạy trong container `rabbitmq-setup`
// sau khi RabbitMQ healthy. CHẠY NHIỀU LẦN KHÔNG LỖI (mọi bước đều là "đặt về trạng thái mong muốn"):
//   1. tạo/cập nhật user ứng dụng (mật khẩu lấy từ biến môi trường, không nằm trong definitions.json)
//   2. cấp quyền cho user đó trên vhost "/"
//   3. nạp definitions.json (exchange, queue, binding, DLX/DLQ)
//   4. đối chiếu lại: thiếu exchange/queue/binding nào thì thoát mã 1
//
// Không dùng thư viện ngoài: chỉ fetch có sẵn của Node.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUEST_TIMEOUT_MS = 10_000;
const WAIT_FOR_API_MS = 90_000;
const VHOST = encodeURIComponent('/');

function fail(message) {
  console.error(`rabbitmq-setup: ${message}`);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    fail(`thiếu biến môi trường ${name}`);
  }
  return value;
}

const baseUrl = requireEnv('RABBITMQ_MANAGEMENT_URL');
const adminUser = requireEnv('RABBITMQ_ADMIN_USER');
const adminPassword = requireEnv('RABBITMQ_ADMIN_PASSWORD');
const appUser = requireEnv('RABBITMQ_APP_USER');
const appPassword = requireEnv('RABBITMQ_APP_PASSWORD');
const definitionsPath =
  process.env.RABBITMQ_DEFINITIONS_FILE ??
  join(dirname(fileURLToPath(import.meta.url)), 'definitions.json');

const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString('base64')}`;

async function api(method, path, body) {
  const response = await fetch(new URL(`/api${path}`, baseUrl), {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    // Không in nội dung request (có mật khẩu); chỉ in phản hồi của server.
    fail(`${method} /api${path} → HTTP ${response.status}: ${text}`);
  }
  // PUT /users, PUT /permissions trả 201 và POST /definitions trả 204, đều không có thân phản hồi.
  return text === '' ? undefined : JSON.parse(text);
}

async function waitForApi() {
  const deadline = Date.now() + WAIT_FOR_API_MS;
  for (;;) {
    try {
      const response = await fetch(new URL('/api/overview', baseUrl), {
        headers: { authorization },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        return;
      }
      if (response.status === 401) {
        fail(
          'đăng nhập management API bị từ chối (sai RABBITMQ_ADMIN_USER/RABBITMQ_ADMIN_PASSWORD?)',
        );
      }
    } catch {
      // chưa kết nối được — thử lại
    }
    if (Date.now() > deadline) {
      fail(`management API ${baseUrl} không sẵn sàng sau ${WAIT_FOR_API_MS / 1000} giây`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function main() {
  const definitions = JSON.parse(await readFile(definitionsPath, 'utf8'));
  if ('users' in definitions || 'permissions' in definitions) {
    fail('definitions.json không được chứa users/permissions (mật khẩu lấy từ .env)');
  }

  await waitForApi();
  console.log('rabbitmq-setup: management API sẵn sàng');

  await api('PUT', `/users/${encodeURIComponent(appUser)}`, { password: appPassword, tags: '' });
  // configure rỗng: ứng dụng KHÔNG được tự khai báo exchange/queue; topology chỉ đến từ definitions.json.
  await api('PUT', `/permissions/${VHOST}/${encodeURIComponent(appUser)}`, {
    configure: '^$',
    write: '.*',
    read: '.*',
  });
  console.log(`rabbitmq-setup: user ứng dụng "${appUser}" đã sẵn sàng`);

  await api('POST', '/definitions', definitions);
  console.log('rabbitmq-setup: đã nạp definitions.json');

  const [exchanges, queues, bindings] = await Promise.all([
    api('GET', `/exchanges/${VHOST}`),
    api('GET', `/queues/${VHOST}`),
    api('GET', `/bindings/${VHOST}`),
  ]);
  const have = {
    exchanges: new Set(exchanges.map((e) => e.name)),
    queues: new Set(queues.map((q) => q.name)),
    bindings: new Set(
      bindings.map((b) => `${b.source}|${b.destination_type}|${b.destination}|${b.routing_key}`),
    ),
  };
  const missing = [
    ...definitions.exchanges
      .filter((e) => !have.exchanges.has(e.name))
      .map((e) => `exchange ${e.name}`),
    ...definitions.queues.filter((q) => !have.queues.has(q.name)).map((q) => `queue ${q.name}`),
    ...definitions.bindings
      .filter(
        (b) =>
          !have.bindings.has(`${b.source}|${b.destination_type}|${b.destination}|${b.routing_key}`),
      )
      .map((b) => `binding ${b.source} -[${b.routing_key}]-> ${b.destination}`),
  ];
  if (missing.length > 0) {
    fail(`sau khi nạp vẫn thiếu: ${missing.join('; ')}`);
  }
  console.log(
    `rabbitmq-setup: xong — ${definitions.exchanges.length} exchange, ${definitions.queues.length} queue, ${definitions.bindings.length} binding`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
