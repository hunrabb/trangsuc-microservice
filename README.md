# Hệ thống quản lý chuỗi cửa hàng trang sức

Monorepo (pnpm workspaces + Turborepo). Luật làm việc và kiến trúc nằm ở [CLAUDE.md](CLAUDE.md); thiết kế chi tiết ở [docs/](docs/).

Giai đoạn hiện tại: **khung chạy được, chưa có nghiệp vụ** (xem `docs/` mục kế hoạch, giai đoạn 1).

| Thành phần                                  | Công nghệ                     | Cổng khi `pnpm dev`             | Cổng khi chạy Docker     |
| ------------------------------------------- | ----------------------------- | ------------------------------- | ------------------------ |
| `apps/gateway`                              | NestJS 12                     | 3000                            | `GATEWAY_PORT` (3000)    |
| `apps/auth`, `inventory`, `sales`, `report` | NestJS 12 + Prisma 7          | 3001 / 3002 / 3003 / 3004       | không mở ra ngoài        |
| `apps/backoffice` (admin + POS)             | React 19 + Vite 8             | 5173                            | `BACKOFFICE_PORT` (8080) |
| `apps/storefront` (website cho khách)       | React 19 + Vite 8             | 5174                            | `STOREFRONT_PORT` (8081) |
| `libs/contracts`, `libs/common`             | TypeScript (build bằng `tsc`) | —                               | —                        |
| PostgreSQL 16.15, RabbitMQ 4.4.0            | Docker                        | 5432 / 5672 / 15672 (127.0.0.1) | không mở ra ngoài        |

## Yêu cầu

- **Node 24.22.2** (dòng LTS 24, ghi ở `.nvmrc`; có thể dùng `nvm use`). Ràng buộc `engines` được ép bằng `engineStrict: true` trong `pnpm-workspace.yaml` (và `engine-strict=true` trong `.npmrc` cho npm): sai phiên bản Node thì `pnpm install` dừng. Không dùng Node 26 vì Prisma 7.10 chưa hỗ trợ.
- **pnpm 12.16.1**: `npm install -g pnpm@12.16.1` (đúng với `packageManager` trong `package.json`).
- **Docker** + Docker Compose v2.

## Cách 1 — Chạy dev: hạ tầng trong Docker, ứng dụng chạy bằng `pnpm dev`

```bash
pnpm install

# 1. Hạ tầng. Lần đầu: điền mật khẩu trong .env (xem ghi chú trong file).
cp .env.example .env
docker compose up -d postgres rabbitmq rabbitmq-setup
docker compose ps          # postgres, rabbitmq: healthy; rabbitmq-setup: exited (0)

# 2. Cấu hình từng app (chạy trên máy nên dùng localhost, mỗi app một cổng).
#    Mật khẩu trong DATABASE_URL phải KHỚP mật khẩu cùng tên trong .env ở gốc.
for app in gateway auth inventory sales report; do cp apps/$app/.env.example apps/$app/.env; done
#    → sửa DIEN_MAT_KHAU trong apps/{auth,inventory,sales,report}/.env

# 3. Chạy tất cả ở chế độ watch (turbo dựng libs/ trước, sinh Prisma client, rồi chạy các app)
pnpm dev
```

Kiểm tra: `curl localhost:3000/api/ping` → `{"service":"inventory","ok":true}`; mở <http://localhost:5173> (backoffice) và <http://localhost:5174> (storefront) sẽ thấy kết quả ping.

Trang quản lý RabbitMQ: <http://localhost:15672> (đăng nhập `RABBITMQ_ADMIN_USER` / `RABBITMQ_ADMIN_PASSWORD`). Chỉ có khi dùng `docker-compose.override.yml` (tự gộp khi chạy `docker compose up`).

### Migration Prisma (máy dev)

Mỗi app có DB có `prisma/schema.prisma` riêng, `prisma.config.ts` (Prisma 7 đặt URL kết nối ở đây, không đặt trong `schema.prisma`) và Prisma client sinh ra ở `src/generated/prisma` (không commit).

```bash
pnpm --filter @jewelry/inventory exec prisma migrate dev --name <ten>
```

- `migrate dev` cần **shadow database**: Prisma chạy thử toàn bộ migration trên một database trống để so sánh. User của từng service không có quyền tạo database, nên `infra/postgres/init/01-init.sh` tạo sẵn database `POSTGRES_SHADOW_DB` (mặc định `jewelry_shadow`) và cấp cho 4 user quyền `CREATE`; biến `SHADOW_DATABASE_URL` trong `apps/<app>/.env` trỏ tới đó (cùng user, cùng `?schema=<tên>`).
- `migrate deploy` (container `*-migrate` và môi trường thật) **không cần shadow database**; `prisma.config.ts` coi `SHADOW_DATABASE_URL` là tuỳ chọn, và container `*-migrate` không được truyền biến này.
- Script init chỉ chạy khi volume `pg_data` còn trống. Thêm user/schema/database sau này phải viết migration SQL hoặc `docker compose down -v` (xoá dữ liệu).

## Cách 2 — Chạy toàn bộ trong Docker

```bash
cp .env.example .env       # điền mật khẩu
docker compose up --build
```

- Mọi container `healthy`; `rabbitmq-setup` và 4 container `*-migrate` thoát với mã 0 (đúng thiết kế).
- Mỗi container `*-migrate` chạy [infra/migrate/wait-for-postgres.mjs](infra/migrate/wait-for-postgres.mjs) trước `prisma migrate deploy`: chờ Postgres thật sự nhận kết nối (không chỉ mở cổng TCP; Postgres đang phục hồi vẫn bị coi là chưa sẵn sàng), tối đa ~60 giây, nghỉ tăng dần 0,5 → 5 giây. Quá hạn thì thoát mã **75** và log nêu lý do của lần thử cuối, **không** chạy migrate. Chỉ việc chờ được thử lại; migration lỗi thì thoát ngay, không thử lại.
- Gateway: <http://localhost:3000> (hoặc `GATEWAY_PORT`) · Backoffice: <http://localhost:8080> · Storefront: <http://localhost:8081>.
- Hai app frontend là file tĩnh phục vụ bởi nginx; nginx cũng chuyển `/api/*` về gateway (cùng origin, không cần CORS).
- **Chỉ** gateway, backoffice, storefront có `ports` trong `docker-compose.yml`. Chạy như production (không mở Postgres/RabbitMQ ra 127.0.0.1): `docker compose -f docker-compose.yml up --build`.
- Dừng: `docker compose down` (giữ dữ liệu). `docker compose down -v` xoá luôn volume `pg_data`, `rabbitmq_data`.

### Kiểm tra nhanh sau khi lên

```bash
curl localhost:3000/api/ping            # {"service":"inventory","ok":true}
curl -i localhost:3000/internal/ping    # 404: gateway không bao giờ chuyển tiếp /internal/*
curl -m 2 localhost:3001/health/live    # lỗi kết nối: auth/inventory/sales/report không mở cổng

# inventory_user KHÔNG đọc được schema sales:
docker compose exec postgres sh -c \
  'PGPASSWORD="$INVENTORY_DB_PASSWORD" psql -h 127.0.0.1 -U inventory_user -d "$POSTGRES_DB" -c "SELECT * FROM sales.bat_ky"'
# ERROR:  permission denied for schema sales
```

### RabbitMQ

Topology (exchange `domain.events` kiểu topic, `dlx` kiểu direct, 3 queue `*.events` + 3 `*.events.dlq`, các binding) nằm trong [infra/rabbitmq/definitions.json](infra/rabbitmq/definitions.json) — không chứa mật khẩu. Container `rabbitmq-setup` chạy [infra/rabbitmq/setup.mjs](infra/rabbitmq/setup.mjs) sau khi RabbitMQ healthy: tạo/cập nhật user ứng dụng (mật khẩu từ `.env`), rồi nạp definitions qua management API. Chạy lại bao nhiêu lần cũng không lỗi:

```bash
docker compose run --rm rabbitmq-setup
```

Healthcheck của `rabbitmq` là `rabbitmq-diagnostics -q check_port_connectivity` (chạy qua `gosu rabbitmq`): chỉ `healthy` khi mọi listener của node, kể cả AMQP 5672, đã nhận kết nối. (`ping` thì báo OK sớm hơn vài giây, khi cổng AMQP chưa mở.)

Sửa tham số của một queue đã tồn tại thì RabbitMQ từ chối nạp (queue "inequivalent"); phải xoá queue đó trước (hoặc tạo queue mới).

## Biến môi trường

- **`.env` ở gốc** — cho Docker Compose: mật khẩu Postgres/RabbitMQ, tên database, cổng mở ra máy chủ. Mỗi service chỉ nhận biến của chính nó (compose ghép `DATABASE_URL` riêng cho từng service). Thiếu biến bắt buộc → `docker compose` dừng ngay và báo đúng tên biến.
- **`apps/<app>/.env`** — chỉ cho `pnpm dev` trên máy dev (URL dùng `localhost`). Docker không đọc.
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

CI (`.github/workflows/ci.yml`): cài thư viện (cache pnpm), format, lint, typecheck, test, build, rồi `docker compose build`.

## Cấu trúc

```
apps/        gateway, auth, inventory, sales, report (NestJS) · backoffice, storefront (React)
libs/        contracts, common
infra/       postgres/init (user + schema + shadow DB) · rabbitmq (definitions.json, setup.mjs) · migrate (chờ Postgres cho *-migrate)
docs/        thiết kế và kế hoạch
```
