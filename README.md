# Hệ thống quản lý chuỗi cửa hàng trang sức

Monorepo (pnpm workspaces + Turborepo). Luật làm việc và kiến trúc nằm ở [CLAUDE.md](CLAUDE.md); thiết kế chi tiết ở [docs/](docs/).

**PostgreSQL development đã cutover ngày 2026-11-10:** `docker compose up` mặc định dùng bốn PostgreSQL/volume độc lập cho Auth, Inventory, Sales và Report. DB legacy cùng volume vẫn giữ nguyên nhưng role ứng dụng đã khóa đăng nhập; đừng dùng cấu hình legacy để ghi dữ liệu mới. Xem [tiến độ](docs/database-separation-progress.md) và [runbook](docs/database-migration-runbook.md). Không dùng `down -v` hoặc `--remove-orphans`.

Giai đoạn hiện tại: **5 — sự kiện và báo cáo**, đang triển khai. POS Phase 4 đã có backend,
giao diện và cơ chế phục hồi; Report Phase 5 đã có phần doanh thu POS nhưng chưa đủ toàn bộ
acceptance criteria. Xem `docs/phase5-progress.md` và README của từng service để đối chiếu tiến độ.

| Thành phần                                  | Công nghệ                     | Cổng khi `pnpm dev`             | Cổng khi chạy Docker     |
| ------------------------------------------- | ----------------------------- | ------------------------------- | ------------------------ |
| `apps/gateway`                              | NestJS 12                     | 3000                            | `GATEWAY_PORT` (3000)    |
| `apps/auth`, `inventory`, `sales`, `report` | NestJS 12 + Prisma 7          | 3001 / 3002 / 3003 / 3004       | không mở ra ngoài        |
| `apps/backoffice` (admin + POS)             | React 19 + Vite 8             | 5173                            | `BACKOFFICE_PORT` (8080) |
| `apps/storefront` (website cho khách)       | React 19 + Vite 8             | 5174                            | `STOREFRONT_PORT` (8081) |
| `libs/contracts`, `libs/common`             | TypeScript (build bằng `tsc`) | —                               | —                        |
| PostgreSQL 16.15, RabbitMQ 4.4.0            | Docker                        | DB: 15433–15436; MQ: 5672 / 15672 (127.0.0.1) | không mở ra ngoài |

## Yêu cầu

- **Node 24.22.2** (dòng LTS 24, ghi ở `.nvmrc`; có thể dùng `nvm use`). Ràng buộc `engines` được ép bằng `engineStrict: true` trong `pnpm-workspace.yaml` (và `engine-strict=true` trong `.npmrc` cho npm): sai phiên bản Node thì `pnpm install` dừng. Không dùng Node 26 vì Prisma 7.10 chưa hỗ trợ.
- **pnpm 12.16.1**: `npm install -g pnpm@12.16.1` (đúng với `packageManager` trong `package.json`).
- **Docker** + Docker Compose v2.

## Cách 1 — Chạy dev: hạ tầng trong Docker, ứng dụng chạy bằng `pnpm dev`

```bash
pnpm install

# 1. Hạ tầng. Lần đầu: điền mật khẩu trong .env (xem ghi chú trong file).
test -f .env || cp .env.example .env
docker compose up -d auth-postgres inventory-postgres sales-postgres report-postgres rabbitmq rabbitmq-setup
docker compose ps          # 4 DB và rabbitmq: healthy; rabbitmq-setup: exited (0)

# 2. Cấu hình từng app (chạy trên máy nên dùng localhost, mỗi app một cổng).
#    Mật khẩu trong DATABASE_URL phải KHỚP mật khẩu cùng tên trong .env ở gốc.
for app in gateway auth inventory sales report; do test -f apps/$app/.env || cp apps/$app/.env.example apps/$app/.env; done
#    → sửa DIEN_MAT_KHAU trong apps/{auth,inventory,sales,report}/.env

# 3. Sinh khoá JWT (mọi app đều cần để khởi động)
pnpm keys:generate

# 4. Chạy tất cả ở chế độ watch (turbo dựng libs/ trước, sinh Prisma client, rồi chạy các app)
pnpm dev
```

Kiểm tra: `curl localhost:3000/api/ping` → `{"service":"inventory","ok":true}`; mở <http://localhost:5173> (backoffice) và <http://localhost:5174> (storefront) sẽ thấy kết quả ping.

Trang quản lý RabbitMQ: <http://localhost:15672> (đăng nhập `RABBITMQ_ADMIN_USER` / `RABBITMQ_ADMIN_PASSWORD`). Chỉ có khi dùng `docker-compose.override.yml` (tự gộp khi chạy `docker compose up`).

### Migration Prisma (máy dev)

Mỗi app có DB có `prisma/schema.prisma` riêng, `prisma.config.ts` (Prisma 7 đặt URL kết nối ở đây, không đặt trong `schema.prisma`) và Prisma client sinh ra ở `src/generated/prisma` (không commit).

```bash
pnpm --filter @jewelry/inventory exec prisma migrate dev --name <ten>
```

- `migrate dev` cần **shadow database**: Prisma chạy thử toàn bộ migration trên một database trống để so sánh. `infra/postgres/service-init` tạo `<service>_shadow` trong đúng instance service; biến `SHADOW_DATABASE_URL` trong `apps/<app>/.env` trỏ tới đó bằng user riêng của service.
- `migrate deploy` (container `*-migrate` và môi trường thật) **không cần shadow database**; `prisma.config.ts` coi `SHADOW_DATABASE_URL` là tuỳ chọn, và container `*-migrate` không được truyền biến này.
- Script init chỉ chạy khi volume DB tương ứng còn trống. Thêm user/schema/database sau này phải dùng migration/quy trình DBA có backup; không xóa volume để chạy lại init.

## Cách 2 — Chạy toàn bộ trong Docker

```bash
test -f .env || cp .env.example .env       # điền mật khẩu nếu mới tạo
docker compose up --build
```

- Mọi container `healthy`; `rabbitmq-setup` và 4 container `*-migrate` thoát với mã 0 (đúng thiết kế).
- `auth`, `inventory`, `sales`, `report` chỉ `healthy` khi `/health/ready` trả 200 (đã thông tới Postgres); `gateway` dùng `/health/live`.
- Mỗi container `*-migrate` chạy [infra/migrate/wait-for-postgres.mjs](infra/migrate/wait-for-postgres.mjs) trước `prisma migrate deploy`: chờ Postgres thật sự nhận kết nối (không chỉ mở cổng TCP; Postgres đang phục hồi vẫn bị coi là chưa sẵn sàng), tối đa ~60 giây, nghỉ tăng dần 0,5 → 5 giây. Quá hạn thì thoát mã **75** và log nêu lý do của lần thử cuối, **không** chạy migrate. Chỉ việc chờ được thử lại; migration lỗi thì thoát ngay, không thử lại.
- Script này tới image qua build context riêng `migrate-scripts` (`additional_contexts` trong `docker-compose.yml`), còn `infra` bị `.dockerignore` loại khỏi context chính: sửa script chỉ build lại bước cuối của `*-migrate`, không đụng tầng `COPY . .`. Build tay đích `migrate` thì thêm `--build-context migrate-scripts=infra/migrate`.
- Gateway: <http://localhost:3000> (hoặc `GATEWAY_PORT`) · Backoffice: <http://localhost:8080> · Storefront: <http://localhost:8081>.
- Hai app frontend là file tĩnh phục vụ bởi nginx; nginx cũng chuyển `/api/*` về gateway (cùng origin, không cần CORS). Mọi đường `/internal/*` trả **404** (không rơi vào trang SPA).
- **Chỉ** gateway, backoffice, storefront có `ports` trong `docker-compose.yml`; `docker-compose.override.yml` chỉ mở bốn DB và RabbitMQ trên loopback cho dev. Chạy không mở các cổng này: `docker compose -f docker-compose.yml up -d --wait`.
- Dừng ứng dụng khi cần: `docker compose stop`. Giữ nguyên mọi volume, đặc biệt `jewelry_pg_data` legacy.

### Máy yếu (ít RAM, ví dụ WSL 2 ~4 GB): build từng image một

Lần `docker compose up --build` đầu tiên build cùng lúc cả chục image (mỗi image chạy `pnpm install`/`pnpm deploy`). Trên máy ít RAM việc này có thể mất 20–25 phút, làm máy treo (`wsl.exe` timeout) và khiến Postgres/RabbitMQ chập chờn. Hãy build **tuần tự** rồi mới chạy:

```bash
for s in $(docker compose config --services | grep -vE '^((auth|inventory|sales|report)-postgres|rabbitmq|rabbitmq-setup)$'); do
  docker compose build "$s"
done
docker compose up -d --wait
```

- **`COMPOSE_PARALLEL_LIMIT` và `docker compose --parallel N` không giới hạn được việc build** ở Compose 5.x. Đã đo với 5.6.1: ba service vẫn build cùng lúc (kể cả khi đặt `COMPOSE_BAKE=false`), nên đừng trông cậy vào chúng; vòng lặp ở trên mới thật sự tuần tự.
- Các lần sau có thể chạy `docker compose up -d --wait`; khi cần build lại trên máy ít RAM, tiếp tục build từng image bằng vòng lặp trên.

### Gateway chuyển tiếp request

Bảng định tuyến nằm ở [apps/gateway/src/proxy/routes.ts](apps/gateway/src/proxy/routes.ts). Khớp theo đoạn đường dẫn (`/api/pos` không khớp `/api/posx`) và phân biệt hoa thường. Không có trong bảng → `404 NOT_FOUND`.

| Đường ở gateway          | Service     | Đường ở service    | Gateway kiểm token, `aud` |
| ------------------------ | ----------- | ------------------ | ------------------------- |
| `/api/auth/x`            | `auth`      | `/auth/x`          | Không                     |
| `/api/pos/x`             | `sales`     | `/pos/x`           | Có, nhân viên             |
| `/api/online-orders/x`   | `sales`     | `/online-orders/x` | Có, nhân viên             |
| `/api/shop/auth/x`       | `auth`      | `/shop/auth/x`     | Không                     |
| `/api/shop/x`            | `sales`     | `/shop/x`          | Không                     |
| `/api/admin/auth/x`      | `auth`      | `/admin/x`         | Có, nhân viên             |
| `/api/admin/inventory/x` | `inventory` | `/admin/x`         | Có, nhân viên             |
| `/api/admin/sales/x`     | `sales`     | `/admin/x`         | Có, nhân viên             |
| `/api/admin/reports/x`   | `report`    | `/admin/x`         | Có, nhân viên             |
| `/webhooks/bank`         | `sales`     | `/webhooks/bank`   | Không                     |

Đường công khai ở gateway vẫn có thể có endpoint cần đăng nhập: service tự kiểm tra (`/api/auth/me`, endpoint `@Audience('shop')`).

- Query giữ nguyên. Phần sau tiền tố hoặc đường đã viết lại bắt đầu bằng `/internal`, `/health`, hoặc đường có `..`, `%2f`, `\`, `//` → `404`.
- Đường cần đăng nhập: gateway kiểm tra token và `aud` trước khi chuyển tiếp, sai thì trả `401` luôn; `Authorization` vẫn đi xuống và service kiểm tra lại.
- Xoá header `x-user-*` và hop-by-hop; giữ các header khác (`Authorization`, `Content-Type`, `Cookie`...); gắn `x-correlation-id`.
- Body đi nguyên byte, tối đa 1 MB (vượt → `413 PAYLOAD_TOO_LARGE`). Timeout 10 giây. Gateway không tự retry. Service không trả lời → `503 SERVICE_UNAVAILABLE`.

### Rate limit và IP thật

| Đường                            | Giới hạn                                            |
| -------------------------------- | --------------------------------------------------- |
| `POST /api/auth/login`           | 5 lần / phút theo IP + email, 20 lần / phút theo IP |
| `POST /api/auth/google`          | 20 lần / phút theo IP                               |
| `POST /api/auth/refresh`         | 60 lần / phút theo IP                               |
| `POST /api/auth/change-password` | 5 lần / 15 phút theo user, 20 lần / phút theo IP    |

Vượt → `429 RATE_LIMITED` kèm `Retry-After`. Bộ đếm nằm trong bộ nhớ gateway, chỉ đúng với một instance.

Gateway chỉ tin `X-Forwarded-For` từ `TRUSTED_PROXIES` (mặc định hai nginx, `172.30.0.16/31`). Compose cố định mạng `172.30.0.0/24` để gán IP tĩnh cho nginx. Nếu đang có mạng cũ, chạy `docker compose down` (không có `-v`, volume giữ nguyên) trước khi `up`. Nếu `172.30.0.0/24` trùng mạng trên máy chủ, đổi đồng thời subnet, hai IP tĩnh trong `docker-compose.yml` và `TRUSTED_PROXIES`.

### Khoá JWT

Hệ thống dùng một cặp khoá RS256.

```bash
pnpm keys:generate        # tạo secrets/jwt/private.pem và public.pem; đã có thì giữ nguyên
```

- `secrets/jwt/private.pem`: chỉ `auth` được mount.
- `secrets/jwt/public.pem`: gateway và 4 service mount read-only.
- Mọi service nạp khoá lúc khởi động. Auth kiểm private và public là một cặp, khác cặp thì không bật.
- Container chạy bằng uid 1000: file private phải đọc được với uid đó, nếu không `auth` không bật.

### Khoá JWT trên server thật

- Private key thuộc uid 1000 (user `node` trong container), quyền `600`, và chỉ mount vào `auth`:

  ```bash
  sudo chown 1000:1000 secrets/jwt/private.pem
  sudo chmod 600 secrets/jwt/private.pem
  ```

- Không dùng `chmod 644` như CI: khoá trong CI dùng một lần, khoá thật thì không.
- **Đổi khoá:** chuyển hai file cũ ra chỗ khác, chạy `pnpm keys:generate`, đặt quyền file private như trên, rồi restart gateway và mọi service **cùng lúc**.
- Mọi access token cũ lập tức bị từ chối (`401 INVALID_TOKEN`), nên **mọi người phải đăng nhập lại**. Không có giai đoạn chuyển tiếp hai khoá.
- Refresh token là chuỗi ngẫu nhiên trong DB, không ký bằng cặp khoá này. Nếu đổi vì **lộ khoá**, thu hồi thêm mọi phiên cho chắc:

  ```sql
  UPDATE auth."RefreshToken" SET "revokedAt" = now() WHERE "revokedAt" IS NULL;
  ```

### ADMIN đầu tiên

Mật khẩu chỉ nhận từ `ADMIN_PASSWORD` hoặc stdin, không qua tham số dòng lệnh, vì tham số lộ trong lịch sử shell và danh sách tiến trình. Tối thiểu 12 ký tự, tối đa 72 byte.

```bash
# Máy dev (đã pnpm build, chạy migrate, có apps/auth/.env)
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
pnpm --filter @jewelry/auth admin:create -- --email admin@example.com --full-name "Quản Trị"

# Server: truyền qua stdin
docker compose exec -T auth node dist/cli/admin-create.js --email admin@example.com --full-name "Quản Trị" < file-mat-khau
```

Email đã tồn tại thì báo lỗi, không ghi đè.

### Đăng nhập Google trên máy dev

Test tự động không gọi Google thật. Muốn thử thật:

1. Vào [Google Cloud Console](https://console.cloud.google.com/apis/credentials), tạo **OAuth client ID** loại **Web application**. Ở **Authorized JavaScript origins** thêm địa chỉ giao diện dev, ví dụ `http://localhost:5173`.
2. Đặt `GOOGLE_CLIENT_ID=<client id>` trong `apps/auth/.env` (hoặc `.env` ở gốc nếu chạy Docker). Đây không phải bí mật. Không cần client secret. `GOOGLE_JWKS_URL` để mặc định.
3. Bật hạ tầng và chạy migrate, rồi tạo sẵn user có email Google đó: lệnh `admin:create` ở trên là đủ.
4. Lấy ID token, ví dụ từ [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) hoặc giao diện dùng Google Identity Services. ID token phải có `aud` đúng client ID của bạn.
5. Gửi thử:

   ```bash
   curl -i -X POST localhost:3000/api/auth/google \
     -H 'content-type: application/json' -d '{"credential":"<ID token>"}'
   ```

   Trả về `200` kèm `accessToken` và cookie `rt_bo`. Cookie có `Secure`, nên trình duyệt chỉ gửi qua HTTPS hoặc `localhost`.

### Runbook: Thư outbox bị FAILED

Dòng `OutboxEvent` thành `FAILED` sau 10 lần gửi lỗi (nghỉ 2, 4, 8... giây, tối đa 5 phút giữa các lần, tổng khoảng 13 phút).

1. **Xem log** của service, tìm dòng mức `error` có `Không queue nào nhận` hoặc `Dừng gửi`. Dòng log nêu `eventType`, `eventId` và có `correlationId`.
2. **Sửa nguyên nhân.** Thường là thiếu binding cho routing key: thêm vào `infra/rabbitmq/definitions.json`, rồi `docker compose run --rm rabbitmq-setup`. Lỗi ở handler thì deploy bản sửa.
3. **Xem trước** số dòng sẽ đổi, rồi **gửi lại**:

   ```bash
   # Máy dev (đã pnpm build)
   pnpm outbox:requeue -- --service report --dry-run
   pnpm outbox:requeue -- --service report --event-type order.completed
   pnpm outbox:requeue -- --service report --id <uuid>

   # Server: chạy trong container của service, dùng đúng user DB của service đó
   docker compose exec report node dist/cli/outbox-requeue.js --service report --dry-run
   ```

Lệnh bắt buộc có `--service`, chỉ đổi dòng `FAILED` về `PENDING`, đặt lại `attempts = 0`, `nextAttemptAt = null`, và in số dòng đã đổi. Không có `--event-type` hay `--id` thì đổi mọi dòng `FAILED` của service đó.

### Kiểm tra nhanh sau khi lên

```bash
curl localhost:3000/api/ping            # {"service":"inventory","ok":true}
curl -i localhost:3000/internal/ping    # 404: gateway không bao giờ chuyển tiếp /internal/*
curl -i localhost:8080/internal/ping    # 404: nginx của backoffice (và storefront :8081) cũng chặn /internal/*
curl -m 2 localhost:3001/health/live    # lỗi kết nối: auth/inventory/sales/report không mở cổng

# inventory_user chỉ tồn tại trong inventory-postgres; không có sales schema ở đây:
docker compose exec -T inventory-postgres sh -c \
  'PGPASSWORD="$SERVICE_DB_PASSWORD" psql -h 127.0.0.1 -U "$SERVICE_DB_USER" -d "$POSTGRES_DB" -Atqc "SELECT current_database(), current_user"'
# inventory_db|inventory_user
```

### RabbitMQ

Topology (exchange `domain.events` kiểu topic, `dlx` kiểu direct, 3 queue `*.events`, 3 `*.events.dlq`, queue bản sao `report.dlq.observer`, 9 queue chờ `*.events.retry.{5s,30s,5m}`, các binding) nằm trong [infra/rabbitmq/definitions.json](infra/rabbitmq/definitions.json) — không chứa mật khẩu. Container `rabbitmq-setup` chạy [infra/rabbitmq/setup.mjs](infra/rabbitmq/setup.mjs) sau khi RabbitMQ healthy: tạo/cập nhật user ứng dụng (mật khẩu từ `.env`), rồi nạp definitions qua management API. Chạy lại bao nhiêu lần cũng không lỗi:

```bash
docker compose run --rm rabbitmq-setup
```

Healthcheck của `rabbitmq` là `rabbitmq-diagnostics -q check_port_connectivity` (chạy qua `gosu rabbitmq`): chỉ `healthy` khi mọi listener của node, kể cả AMQP 5672, đã nhận kết nối. (`ping` thì báo OK sớm hơn vài giây, khi cổng AMQP chưa mở.)

Sửa tham số của một queue đã tồn tại thì RabbitMQ từ chối nạp (queue "inequivalent"); phải xoá queue đó trước (hoặc tạo queue mới).

## Biến môi trường

- **`.env` ở gốc** — cho Docker Compose: mật khẩu Postgres/RabbitMQ và cổng mở ra máy chủ; `POSTGRES_DB`/`POSTGRES_SHADOW_DB` chỉ dành cho profile legacy. Mỗi service chỉ nhận mật khẩu DB của chính nó (Compose ghép `DATABASE_URL` riêng). Thiếu biến bắt buộc → `docker compose` dừng ngay và báo đúng tên biến.
- **`apps/<app>/.env`** — chỉ cho `pnpm dev` trên máy dev (URL loopback 15433–15436 tới DB riêng). Docker không đọc.
- Mỗi app NestJS kiểm tra biến môi trường bằng zod lúc khởi động; sai/thiếu → log JSON mức `fatal` ghi rõ tên biến rồi thoát mã 1.
- Mật khẩu chỉ nên gồm chữ và số (chúng nằm trong URL). Tạo: `openssl rand -hex 24`.

## Chất lượng

```bash
pnpm lint          # ESLint (gồm luật chặn import xuyên app)
pnpm typecheck
pnpm test
pnpm build
pnpm format:check  # Prettier; `pnpm format` để tự sửa
```

Luật `no-restricted-imports` (xem `eslint.config.mjs`): một app **không** được import code của app khác; chỉ import `@jewelry/contracts` và `@jewelry/common`.

CI (`.github/workflows/ci.yml`): cài thư viện (cache pnpm), format, lint, typecheck, test, build, rồi `docker compose build`. Mọi job chạy trên `ubuntu-24.04` (ghim phiên bản, không dùng `ubuntu-latest`). Job `smoke` chạy cả hệ thống bằng `docker compose -f docker-compose.yml up -d --build --wait` (**không** nạp `docker-compose.override.yml`, tức đúng cấu hình production), kiểm tra chỉ gateway/backoffice/storefront mở cổng, rồi gọi `/api/ping`.

## Cấu trúc

```
apps/        gateway, auth, inventory, sales, report (NestJS) · backoffice, storefront (React)
libs/        contracts, common
tests/       integration (chạy bản build thật của nhiều app)
infra/       postgres/service-init (user + schema + shadow DB riêng) · rabbitmq (definitions.json, setup.mjs) · migrate (chờ Postgres cho *-migrate)
docs/        thiết kế và kế hoạch
```

## Phạm vi đồ án

Chức năng kiểm kê đã được gỡ khỏi Backoffice và API. Các bảng và dữ liệu lịch sử được giữ nguyên; xem [báo cáo gỡ chức năng](docs/stocktaking-removal.md). Chốt tồn kho đêm và báo cáo tồn kho tiếp tục hoạt động.
