# CLAUDE.md

Hệ thống quản lý chuỗi cửa hàng **trang sức** (vàng, bạc, trang sức thời trang): chi nhánh, nhân viên, sản phẩm, giá vàng theo ngày, nhập kho, kiểm kê, tồn kho, bán tại quầy (POS), bán online qua website, thu mua và đổi hàng, báo cáo.

File này là luật chung cho mọi phiên làm việc. Prompt của từng việc nói **làm gì**; file này nói **làm thế nào cho đúng**.

## 1. Nguồn sự thật

- `docs/thiet-ke.md` — thiết kế hệ thống: service, sự kiện, luồng nghiệp vụ, CSDL, Prisma, xử lý đồng thời.
- `docs/ke-hoach.md` — kế hoạch theo giai đoạn, tiêu chí hoàn thành, checklist review.
- `libs/contracts` — kiểu sự kiện, routing key, mã lỗi, DTO giữa các service.

Thiết kế không nói tới một chuyện → **không tự đoán**: chọn cách đơn giản nhất phù hợp với file này và **ghi lại** trong báo cáo cuối. Thiết kế mâu thuẫn với yêu cầu trong prompt → **dừng lại và hỏi**.

## 2. Kiến trúc

| Service | Schema | Sở hữu |
|---|---|---|
| `gateway` | — | Cửa vào duy nhất: kiểm tra JWT, rate limit, định tuyến |
| `auth` | `auth` | Chi nhánh, nhân viên, vai trò, đăng nhập, token |
| `inventory` | `inventory` | Kim loại, giá kim loại, sản phẩm, biến thể, hàng có tem, kho, tồn kho, nhập hàng, kiểm kê, giữ hàng, chọn chi nhánh cho đơn online |
| `sales` | `sales` | Hoá đơn POS, đơn online, khách hàng, thanh toán chuyển khoản, hoàn tiền, thu mua, đổi hàng, trả hàng |
| `report` | `report` | Bảng tổng hợp doanh thu, lợi nhuận, tồn kho |

- Một PostgreSQL, một database, 4 schema; mỗi service kết nối bằng user DB riêng, chỉ có quyền trên schema của mình.
- Giao tiếp: gọi HTTP nội bộ **chỉ** cho luồng POS (sales → inventory); mọi thứ khác qua RabbitMQ, exchange `domain.events` kiểu topic.
- Không có điều chuyển hàng giữa các kho. Không có Redis. Không tích hợp sàn TMĐT.

## 3. Cấu trúc repo

```
apps/
  gateway/  auth/  inventory/  sales/  report/     NestJS; mỗi app có prisma/ riêng (trừ gateway)
  backoffice/                                      React, nội bộ: admin + POS + xử lý đơn online
  storefront/                                      React, công khai: website bán hàng cho khách
libs/
  contracts/   kiểu sự kiện, routing key, mã lỗi, DTO giữa service (zod schema + type)
  common/      logger, correlationId, exception filter, health, config, JwtGuard, RolesGuard,
               outbox, consumer cơ sở
infra/
  postgres/init/   script tạo schema + user (chỉ chạy khi volume trống)
  rabbitmq/        definitions.json (topology, không có mật khẩu), setup.mjs (nạp qua management API)
secrets/           (gitignore) jwt_private.pem, jwt_public.pem
docs/
docker-compose.yml, docker-compose.override.yml (chỉ dev), .env.example
```

## 4. Lệnh

> Cập nhật mục này khi lệnh thay đổi. Cần Node 26.13.0 (`.nvmrc`) và pnpm 12.16.1 (`packageManager`).
> `<app>` là một trong `auth`, `inventory`, `sales`, `report`; tên package là `@jewelry/<app>`.

```bash
pnpm install
cp .env.example .env                            # lần đầu: điền mật khẩu (cho Docker Compose)
cp apps/<app>/.env.example apps/<app>/.env      # lần đầu, cho gateway/auth/inventory/sales/report (cho pnpm dev)
docker compose up -d postgres rabbitmq rabbitmq-setup   # hạ tầng cho dev (override mở 127.0.0.1:5432 và :15672)
pnpm dev                                        # chạy mọi app ở chế độ watch
pnpm --filter @jewelry/<app> exec prisma migrate dev --name <ten>   # CHỈ máy dev; cần database shadow
pnpm --filter @jewelry/<app> db:generate        # sinh Prisma client (turbo tự chạy trước build/typecheck/dev)
pnpm test                                       # hiện mới có test cấu hình/chốt chặn; chưa có integration
pnpm lint && pnpm typecheck
pnpm build
pnpm format:check                               # Prettier (pnpm format để tự sửa)
docker compose up --build                       # chạy cả hệ thống (kèm override dev)
docker compose -f docker-compose.yml up --build # chạy như production (không mở cổng dev)
docker compose run --rm rabbitmq-setup          # nạp lại topology RabbitMQ sau khi sửa definitions.json
```

Chưa có (làm ở giai đoạn sau): `prisma db seed` (chưa có seed), `pnpm test:concurrency`.

## 5. Ranh giới giữa các service — KHÔNG được vi phạm

- Service **chỉ** đọc/ghi schema của mình. Không truy vấn, không khoá ngoại sang schema khác.
- Tham chiếu sang service khác chỉ lưu **ID** (UUID). Dữ liệu cần hiển thị (tên, giá, trọng lượng) được **chép lại lúc ghi**.
- Mỗi service có `schema.prisma` và Prisma client **riêng**. Không đặt Prisma schema, Prisma client hay logic nghiệp vụ trong `libs/`.
- `libs/` chỉ chứa hạ tầng dùng chung và hợp đồng giữa các service.
- Thay đổi `libs/contracts` chỉ theo kiểu **thêm**. Đổi tên/xoá trường → tạo sự kiện phiên bản mới (`<ten>.v2`).
- Một app **không** import code của app khác; chỉ import từ `libs/`. ESLint (`no-restricted-imports`) chặn việc này.
- Trong `sales` và `inventory`, code chia theo luồng: `pos/` (bán tại quầy), `online/` (bán online), phần dùng chung ở `core/` (sales) hoặc `stock/` (inventory). `pos/` và `online/` được gọi phần dùng chung nhưng **không** import lẫn nhau. Luật dùng chung (bảng chuyển trạng thái, "còn bán được", chốt giá) chỉ nằm ở phần dùng chung. Cửa vào (controller HTTP, handler RabbitMQ) chỉ nhận việc, kiểm tra dữ liệu và gọi service.

## 6. Database

- Khoá chính `id` UUID. Mọi bảng có `createdAt`, `updatedAt`. Bảng chứng từ (phiếu, hoá đơn) có `version Int`.
- **Tiền:** `Decimal(15,2)`; trong TypeScript dùng `Prisma.Decimal`, **không bao giờ** `number`.
- **Trọng lượng:** đơn vị **chỉ**, `Decimal(12,4)` (1 chỉ = 3,75 g = 10 phân = 100 ly).
- Bảng chỉ ghi thêm, không UPDATE/DELETE: `StockMovement`, `MetalPrice`, `PriceHistory`, `OrderStatusHistory`, `AuditLog`.
- CHECK constraint viết tay trong file migration SQL (Prisma không sinh): `onHand >= 0`, `reserved >= 0`, `reserved <= onHand`, `onlineBuffer >= 0`, `quantity > 0`, tiền `>= 0`.
- Migration: `prisma migrate dev` chỉ trên máy dev; server dùng `prisma migrate deploy` ở container `*-migrate` riêng. Migration phải tương thích ngược khi bảng đã có dữ liệu.
- Seed dùng upsert, id cố định, từ chối chạy khi `NODE_ENV=production`.

## 7. Xử lý đồng thời (trong một service)

1. Nhiều thao tác ghi đi cùng nhau → **một** `prisma.$transaction`.
2. Trong transaction **không** gọi HTTP, không gửi message, không gửi email, không chờ người dùng.
3. **Cấm** kiểu "đọc → kiểm tra trong code → ghi" trên dữ liệu dùng chung. Dùng:
   - điều kiện đơn giản → **UPDATE có điều kiện** (`$queryRaw` với `WHERE … AND onHand - reserved >= qty RETURNING …`), kiểm tra số dòng bị ảnh hưởng;
   - cần đọc nhiều giá trị mới quyết định được (ví dụ giá vốn bình quân) → `SELECT … FOR UPDATE` rồi UPDATE.
4. Khoá nhiều dòng → **sắp theo id** (`variantId`, `jewelryItemId`) trước; gộp dòng trùng.
5. Lỗi deadlock `40P01` → chạy lại cả transaction tối đa 3 lần, nghỉ 20–60 ms. Đặt `SET LOCAL lock_timeout = '3s'`.
6. Chứng từ người dùng xem rồi mới sửa/duyệt → **khoá lạc quan**: client gửi `version`, `updateMany({ where: { id, version } })`, 0 dòng → `409 VERSION_CONFLICT`.
7. Đổi trạng thái → `UPDATE … WHERE id = ? AND status IN (<trạng thái được phép>)`; 0 dòng → `409 INVALID_STATE`. Bảng chuyển trạng thái hợp lệ ở `docs/thiet-ke.md`.
8. Hàng có tem: bán/giữ/thu bằng `UPDATE JewelryItem SET status = … WHERE id = ? AND status = 'IN_STOCK'`.
9. Dùng unique constraint làm trọng tài cho mọi thứ có thể bị tạo trùng; bắt lỗi Prisma `P2002` và kiểm tra **đúng cột** bị trùng.

## 8. Nhất quán giữa các service

- **Không bao giờ** gửi thẳng lên RabbitMQ từ code nghiệp vụ. Ghi `OutboxEvent` trong **cùng transaction** với thay đổi dữ liệu; worker trong `libs/common` gửi đi (`FOR UPDATE SKIP LOCKED`, publisher confirm, `mandatory: true`).
- Mỗi thư có `eventId` (= id dòng outbox) và `correlationId`.
- Consumer: ghi `ProcessedEvent(eventId)` trong **cùng transaction** với việc nghiệp vụ; `P2002` trên `eventId` → bỏ qua, vẫn ack. Dùng consumer cơ sở trong `libs/common`, không tự viết lại.
- Phân loại lỗi trong consumer:
  - tạm thời (DB bận, timeout, `40P01`) → ném lỗi để retry (5 s → 30 s → 5 phút → DLQ);
  - vĩnh viễn (sai format, không tìm thấy dữ liệu) → đưa thẳng DLQ;
  - **nghiệp vụ** (hết hàng) → **không phải lỗi**: ack và phát sự kiện kết quả (ví dụ `stock.reserve_failed`).
- Payload nhận vào phải được kiểm tra bằng zod schema trong `libs/contracts`.
- Mọi xử lý phải đúng **dù thư đến trùng, đến lệch thứ tự, hay chạy song song nhiều instance**. Huỷ đến trước khi giữ hàng → ghi `StockReservation(RELEASED, quantity 0)` làm dấu.
- Gọi trực tiếp (POS): timeout 3 s; idempotent theo `orderId`; retry 1–2 lần chỉ với lỗi tạm thời; thất bại → gọi `release` theo `orderId`.

## 9. Nghiệp vụ trang sức

- Hai cách quản lý hàng: `trackingType = SERIAL` (mỗi chiếc một `JewelryItem` có `tagCode`, trọng lượng, tiền công, giá vốn riêng) và `QUANTITY` (đếm bằng `InventoryItem.onHand`).
- Giá hàng `METAL_RATE` = `metalWeight × sellPrice hiện tại của kim loại (theo chỉ) + laborFee + stoneFee`. Giá `FIXED` = giá cố định / giá theo chi nhánh.
- `MetalPrice` chỉ ghi thêm; giá hiện tại = dòng có `effectiveFrom` mới nhất `<= now()`.
- **Giá được chốt** lúc tạo hoá đơn POS hoặc lúc giữ hàng đơn online: dòng hoá đơn chép `metalPriceAtSale`, `metalWeight`, `laborFee`, `stoneFee`, `productName`, `tagCode`. Không bao giờ tính lại giá hoá đơn đã tạo theo giá vàng mới.
- Thu mua: giá thu = `metalWeight × buyPrice` − khấu trừ theo cấu hình. Đổi hàng = một hoá đơn có `OrderItem` (bán) và `TradeInItem` (thu vào).
- Đơn online chọn **một** chi nhánh có đủ cả đơn, ưu tiên chi nhánh còn nhiều hàng nhất; không tách đơn. Số còn bán online = `onHand − reserved − onlineBuffer`.
- Thanh toán: **chỉ chuyển khoản**. Nội dung chuyển khoản = `Order.code`. `BankTransaction.bankTxnRef` unique. Cửa hàng trả tiền cho khách → `Payment(type = PAYOUT)`.
- Ghi `AuditLog` cho: đổi giá kim loại, sửa trọng lượng, điều chỉnh kiểm kê, huỷ hoá đơn, thu mua.

## 10. API

- Client chỉ gọi qua gateway. Chỉ gateway, backoffice và storefront mở port ra ngoài.
- Tiền tố đường dẫn ở gateway: `/api/pos/*` (POS), `/api/shop/*` (website, công khai), `/api/online-orders/*` (xử lý đơn online), `/api/admin/*`, `/webhooks/bank`. Đường `/internal/*` **không bao giờ** được gateway chuyển tiếp.
- `channel` của đơn (`POS` / `WEBSITE`) do server tự đặt theo đường dẫn được gọi, không lấy từ body.
- Mọi body vào kiểm tra bằng DTO + `class-validator` (hoặc zod). Không tin `branchId`, `role` từ client: lấy từ `req.user` và lọc truy vấn theo chi nhánh người dùng được phép.
- Endpoint tạo hoá đơn / đơn hàng bắt buộc header `Idempotency-Key`; lưu `idempotencyKey` (unique) + `requestHash`; trùng key khác nội dung → `422 IDEMPOTENCY_KEY_REUSED`.
- Định dạng lỗi thống nhất (exception filter trong `libs/common`):
  ```json
  { "code": "OUT_OF_STOCK", "message": "...", "details": {}, "correlationId": "..." }
  ```
  Mã lỗi lấy từ `libs/contracts`. Lỗi không lường trước → `500 INTERNAL_ERROR`, stack trace chỉ ghi log, không trả ra ngoài.
- Endpoint mới phải có trong OpenAPI.

## 11. Xác thực

- Access token: JWT **RS256**, 15 phút; chỉ `auth` giữ private key, các service khác chỉ có public key. Kiểm tra luôn ép `algorithms: ['RS256']`, `issuer`, `audience`, chọn key theo `kid`.
- Refresh token: chuỗi ngẫu nhiên, lưu **bản băm** SHA-256; hạn trượt 7 ngày, hạn tuyệt đối 30 ngày (`sessionStartedAt`); xoay vòng mỗi lần dùng; token đã thu hồi bị dùng lại → thu hồi mọi phiên của user. Cookie `httpOnly; Secure; SameSite=Strict; Path=/auth/refresh`.
- Vai trò: `ADMIN` (toàn hệ thống, `branchId = null`), `MANAGER`, `STAFF` theo chi nhánh. Dùng `JwtGuard` + `RolesGuard` + `@Roles(...)` trong `libs/common`.
- Gateway xoá mọi header `x-user-*` từ client.
- Mật khẩu: bcrypt; thông báo lỗi đăng nhập chung "Sai email hoặc mật khẩu"; rate limit bằng `@nestjs/throttler`.

## 12. Cấu hình, log, health

- Đọc cấu hình **chỉ** qua `ConfigService`; mọi biến được kiểm tra bằng schema lúc khởi động; thiếu → service không bật. **Không** giá trị mặc định cho bí mật.
- Không commit `.env`, `secrets/`, khoá, mật khẩu. Thêm biến mới → cập nhật `.env.example`.
- Log JSON ra stdout, mỗi dòng có `service` và `correlationId`. Truyền `x-correlation-id` khi gọi HTTP và trong header của message. Không log mật khẩu, token, nội dung cookie.
- Mỗi service có `/health/live` và `/health/ready` (kiểm tra Postgres, RabbitMQ).

## 13. Test

- Unit: tính giá, chuyển trạng thái, phân loại lỗi.
- Integration: Postgres thật (Testcontainers), không mock Prisma cho logic ghi dữ liệu.
- **Đồng thời** — bắt buộc cho mọi chỗ ghi dữ liệu dùng chung. Bắn song song bằng `Promise.all`, kiểm tra kết quả cuối trong DB. Ví dụ: N request tranh một tem → đúng 1 thành công; trùng `Idempotency-Key` → 1 hoá đơn; thư trùng `eventId` → xử lý 1 lần.
- Contract: payload sự kiện khớp zod schema trong `libs/contracts`.

## 14. Cách làm việc

- Chỉ làm đúng phạm vi trong prompt. Thấy việc khác cần làm → ghi vào báo cáo, không tự làm.
- Không thêm thư viện mới nếu prompt không cho phép; cần thì đề xuất trong báo cáo.
- Không sửa migration đã commit; tạo migration mới.
- Trước khi báo xong: chạy `pnpm lint`, `pnpm typecheck`, `pnpm test` (và `pnpm test:concurrency` nếu có ghi dữ liệu dùng chung). Không báo xong khi còn test đỏ.
- **Báo cáo cuối** gồm: file đã tạo/sửa; migration mới; sự kiện/API mới hoặc thay đổi; **mọi chỗ phải tự quyết định** mà thiết kế không nói; việc còn dở hoặc rủi ro thấy được.