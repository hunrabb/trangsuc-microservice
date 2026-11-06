// Chạy TRƯỚC `prisma migrate deploy` trong container `*-migrate`: chờ Postgres thật sự nhận kết nối.
//
// Vì sao không chỉ thử mở cổng TCP: khi Postgres đang khởi động hoặc phục hồi sau sự cố
// (`the database system is in recovery mode`) nó vẫn nhận TCP nhưng từ chối mọi kết nối với SQLSTATE 57P03.
// Nên script gửi StartupMessage của giao thức Postgres (không cần mật khẩu) và đọc phản hồi đầu tiên:
//   - 'R' (yêu cầu xác thực)             → Postgres sẵn sàng nhận kết nối → thoát 0
//   - 'E' với SQLSTATE 57P03 hoặc 53300  → đang khởi động/phục hồi/tắt, hoặc hết số kết nối → thử lại
//   - 'E' với SQLSTATE khác (sai mật khẩu, thiếu database...) → Postgres đang chạy; thoát 0 để Prisma
//     báo đúng lỗi thật. Script này chỉ chờ "Postgres lên", không chẩn đoán cấu hình.
//   - lỗi mạng (từ chối kết nối, chưa phân giải được tên máy, không phản hồi trong 3 giây) → thử lại
//
// Thử lại với khoảng nghỉ tăng dần 0,5 → 1 → 2 → 4 → 5 giây (tối đa 5 giây), tổng cộng tối đa ~60 giây.
// Quá hạn: thoát mã 75 (EX_TEMPFAIL) và log nêu lý do của lần thử cuối; container KHÔNG chạy migrate.
// Script không bao giờ chạy hay thử lại migration; lỗi của chính migration thuộc về `prisma migrate deploy`.
//
// Không dùng thư viện ngoài (chỉ node:net). Không in DATABASE_URL (có mật khẩu), chỉ in host:port.
import net from 'node:net';

const MAX_WAIT_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 3_000;
const FIRST_DELAY_MS = 500;
const MAX_DELAY_MS = 5_000;
const EXIT_TIMEOUT = 75;
const EXIT_CONFIG = 1;
const PROTOCOL_3_0 = 196608; // 3 << 16

// SQLSTATE mà Postgres trả khi máy chủ đã nghe cổng nhưng chưa nhận kết nối được.
const RETRY_SQLSTATES = new Map([
  ['57P03', 'đang khởi động, phục hồi hoặc tắt'],
  ['53300', 'hết số kết nối cho phép'],
]);

function log(message) {
  console.log(`wait-for-postgres: ${message}`);
}

function fail(message, code) {
  console.error(`wait-for-postgres: LỖI — ${message}`);
  process.exit(code);
}

function readTarget() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    fail('DATABASE_URL chưa được đặt', EXIT_CONFIG);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    // Không in `raw`: có mật khẩu.
    return fail('DATABASE_URL không phải URL hợp lệ', EXIT_CONFIG);
  }
  const user = decodeURIComponent(url.username);
  if (!user) {
    fail('DATABASE_URL thiếu tên người dùng', EXIT_CONFIG);
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''), // URL giữ dấu [] quanh IPv6
    port: Number(url.port || 5432),
    user,
    database: decodeURIComponent(url.pathname.slice(1)) || user,
  };
}

/** StartupMessage: Int32 độ dài, Int32 phiên bản giao thức, các cặp "khoá\0giá trị\0", kết thúc bằng \0. */
function startupMessage(user, database) {
  const params = Buffer.from(`user\0${user}\0database\0${database}\0\0`, 'utf8');
  const message = Buffer.alloc(8 + params.length);
  message.writeInt32BE(message.length, 0);
  message.writeInt32BE(PROTOCOL_3_0, 4);
  params.copy(message, 8);
  return message;
}

/** ErrorResponse: 'E', Int32 độ dài (không tính byte 'E'), rồi các trường [1 byte mã][chuỗi\0]... kết thúc bằng \0. */
function parseErrorFields(buffer) {
  const fields = {};
  let offset = 5;
  while (offset < buffer.length && buffer[offset] !== 0) {
    const code = String.fromCharCode(buffer[offset]);
    const end = buffer.indexOf(0, offset + 1);
    if (end === -1) {
      break;
    }
    fields[code] = buffer.toString('utf8', offset + 1, end);
    offset = end + 1;
  }
  return fields;
}

/** Quyết định từ phần phản hồi đã nhận: 'incomplete' (chờ thêm), 'ready', hoặc 'retry'. */
function classifyResponse(buffer) {
  if (buffer.length === 0) {
    return { state: 'incomplete' };
  }
  const type = String.fromCharCode(buffer[0]);
  if (type === 'R') {
    return { state: 'ready' };
  }
  if (type === 'E') {
    if (buffer.length < 5 || buffer.length < 1 + buffer.readInt32BE(1)) {
      return { state: 'incomplete' };
    }
    const fields = parseErrorFields(buffer);
    const meaning = RETRY_SQLSTATES.get(fields.C);
    if (meaning) {
      return { state: 'retry', reason: `Postgres ${meaning} (${fields.C}: ${fields.M})` };
    }
    return {
      state: 'ready',
      note: `Postgres đã trả lời (${fields.C}: ${fields.M}); để Prisma báo lỗi chi tiết`,
    };
  }
  return { state: 'retry', reason: 'cổng này không trả lời theo giao thức Postgres' };
}

function describeNetworkError(error, host) {
  switch (error.code) {
    case 'ECONNREFUSED':
      return 'kết nối bị từ chối (Postgres chưa mở cổng)';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `chưa phân giải được tên máy "${host}" (container Postgres chưa chạy?)`;
    case 'ECONNRESET':
      return 'kết nối bị ngắt giữa chừng';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `không tới được máy "${host}"`;
    default:
      return `${error.code ?? error.name}: ${error.message}`;
  }
}

/** Quá hạn 3 giây: nói rõ đang kẹt ở giai đoạn nào (phân giải tên → mở TCP → chờ Postgres trả lời). */
function describeTimeout(stage, target) {
  const limit = `${ATTEMPT_TIMEOUT_MS / 1000} giây`;
  switch (stage) {
    case 'lookup':
      return `chưa phân giải được tên máy "${target.host}" sau ${limit} (container Postgres đã dừng hoặc chưa chạy?)`;
    case 'connect':
      return `không mở được kết nối TCP tới ${target.host}:${target.port} sau ${limit} (máy không phản hồi: kiểm tra mạng/tường lửa)`;
    default:
      return `đã kết nối ${target.host}:${target.port} nhưng Postgres không trả lời sau ${limit}`;
  }
}

function probe(target) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    let received = Buffer.alloc(0);
    let settled = false;
    // Địa chỉ IP thì không có bước phân giải tên (không phát sự kiện 'lookup').
    let stage = net.isIP(target.host) ? 'connect' : 'lookup';
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(ATTEMPT_TIMEOUT_MS, () =>
      finish({ state: 'retry', reason: describeTimeout(stage, target) }),
    );
    socket.on('lookup', () => {
      stage = 'connect';
    });
    socket.on('connect', () => {
      stage = 'startup';
      socket.write(startupMessage(target.user, target.database));
    });
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      const result = classifyResponse(received);
      if (result.state !== 'incomplete') {
        finish(result);
      }
    });
    socket.on('error', (error) =>
      finish({ state: 'retry', reason: describeNetworkError(error, target.host) }),
    );
    socket.on('close', () =>
      finish({ state: 'retry', reason: 'Postgres đóng kết nối mà không trả lời' }),
    );
  });
}

const seconds = (ms) => (ms / 1000).toFixed(1);

async function main() {
  const target = readTarget();
  const where = `${target.host}:${target.port}`;
  const startedAt = Date.now();
  let delay = FIRST_DELAY_MS;

  for (let attempt = 1; ; attempt += 1) {
    const result = await probe(target);
    const elapsed = Date.now() - startedAt;
    if (result.state === 'ready') {
      log(`Postgres ${where} sẵn sàng sau ${seconds(elapsed)} giây (lần thử ${attempt})`);
      if (result.note) {
        log(result.note);
      }
      return;
    }

    if (elapsed >= MAX_WAIT_MS) {
      fail(
        `Postgres ${where} chưa sẵn sàng sau ${seconds(elapsed)} giây (${attempt} lần thử). ` +
          `Lý do lần thử cuối: ${result.reason}. Không chạy prisma migrate deploy.`,
        EXIT_TIMEOUT,
      );
    }
    const wait = Math.min(delay, MAX_WAIT_MS - elapsed);
    log(
      `Postgres ${where} chưa sẵn sàng: ${result.reason}. Thử lại sau ${seconds(wait)} giây ` +
        `(đã chờ ${seconds(elapsed)}/${MAX_WAIT_MS / 1000} giây, lần thử ${attempt})`,
    );
    await new Promise((resolve) => setTimeout(resolve, wait));
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error), EXIT_CONFIG));
