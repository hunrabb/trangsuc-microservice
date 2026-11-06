# Kế hoạch triển khai hệ thống quản lý chuỗi trang sức

Nov 6, 2026 · @khai

## 1. Nguyên tắc

Làm theo **lát dọc** (mỗi lần một tính năng chạy được từ màn hình tới database), không làm theo tầng; mỗi giai đoạn kết thúc bằng thứ chạy được và có test chứng minh, rồi mới sang giai đoạn sau.

1. **Dựng khung chạy được trước (walking skeleton).** Một request đi được từ React → gateway → service → Postgres → RabbitMQ, dù chưa có nghiệp vụ. Mọi rủi ro hạ tầng lộ ra ở tuần đầu, không phải tuần cuối.
2. **Thiết kế hợp đồng trước khi code.** API (OpenAPI) và sự kiện (kiểu trong `libs/contracts`) chốt trước; hai service chỉ cần thống nhất hợp đồng là làm song song được.
3. **Luồng đồng bộ trước, bất đồng bộ sau.** POS (gọi trực tiếp) xong rồi mới làm đơn online (Saga qua RabbitMQ). Sai ở luồng đơn giản thì dễ sửa hơn nhiều.
4. **Mỗi cơ chế ở chương 3–4 có một bài test chứng minh.** Không có test bắn đồng thời thì coi như chưa làm.
5. **Tài liệu thiết kế là nguồn sự thật.** Mọi quyết định mới ghi vào tài liệu (kèm lý do) trước khi đưa cho Claude code; code lệch tài liệu thì sửa một trong hai ngay.
6. **Không tối ưu sớm.** Một instance mỗi service, một Postgres, một RabbitMQ là đủ cho chuỗi cửa hàng; chỉ mở rộng khi số đo cho thấy cần.

## 2. Lộ trình tổng

&#91;embedded content: lộ trình · 10 giai đoạn\]

Giai đoạn 0–4 cho ra hệ thống bán tại quầy dùng được; 5–7 thêm báo cáo, bán online và thu mua; 8–9 gia cố rồi đưa vào chạy thật. Thời gian là ước tính, phụ thuộc tốc độ chốt nghiệp vụ và review code.

## 3. Giai đoạn 0–2: chốt thiết kế, nền móng, auth

### Giai đoạn 0. Chốt thiết kế (1–2 tuần)

Mục tiêu: không còn câu hỏi nghiệp vụ nào ảnh hưởng tới cấu trúc dữ liệu.

- [ ] Chốt 3 câu còn mở về trang sức: giá bạc theo ngày hay cố định; bán online theo mẫu + ni hay chọn từng chiếc; mức khấu trừ khi thu mua.
- [ ] Cập nhật tài liệu thiết kế: mô hình hàng trang sức (Metal, MetalPrice, JewelryItem), chốt giá, thu mua/đổi, AuditLog, thay mọi ví dụ quần áo.
- [ ] Thiết kế API: danh sách endpoint từng service (method, đường dẫn, body, response, mã lỗi, vai trò được gọi), viết thành file OpenAPI.
- [ ] Liệt kê toàn bộ sự kiện và payload trong `libs/contracts`.
- [ ] Danh sách màn hình: admin (chi nhánh, nhân viên, sản phẩm, giá vàng, nhập kho, in tem, kiểm kê, báo cáo), POS (bán, thu mua, đổi), website (danh mục, chi tiết, giỏ, thanh toán, tra đơn).
- [ ] Ghi các quyết định kiến trúc thành ADR ngắn (mỗi quyết định: bối cảnh, lựa chọn, lý do), ví dụ "bỏ điều chuyển hàng", "đơn online chọn kho nhiều hàng nhất".

**Xong khi:** tài liệu thiết kế + OpenAPI + contracts đủ để giao một service cho Claude mà không phải đoán.

### Giai đoạn 1. Nền móng chạy được (1 tuần)

Mục tiêu: `docker compose up` là cả hệ thống lên, một request đi xuyên mọi tầng.

- [ ] Monorepo (NestJS monorepo hoặc Nx + pnpm): `apps/gateway`, `apps/auth`, `apps/inventory`, `apps/sales`, `apps/report`, `apps/web` (React); `libs/contracts`, `libs/common`.
- [ ] Docker Compose: Postgres (script tạo 4 schema + 4 user), RabbitMQ (`definitions.json`: exchange, queue, DLX, DLQ), các service; healthcheck, `depends_on: service_healthy`, volume; chỉ gateway mở port.
- [ ] `.env.example`, `@nestjs/config` kiểm tra biến lúc khởi động.
- [ ] `libs/common` dùng chung: logger JSON + correlationId, exception filter + định dạng lỗi, `/health/live` và `/health/ready`, `JwtGuard` + `RolesGuard`, Prisma theo từng schema.
- [ ] `libs/common` phần messaging: Outbox (bảng, worker `FOR UPDATE SKIP LOCKED`, publisher confirm, `mandatory`), consumer cơ sở (ProcessedEvent trong transaction, phân loại lỗi, retry/DLQ).
- [ ] CI (GitHub Actions): lint, type-check, test, build image cho mỗi lần push.

**Xong khi:** gọi một endpoint thử qua gateway, thấy cùng correlationId trong log của gateway và service; một sự kiện thử đi từ outbox tới consumer; tắt RabbitMQ 30 giây rồi bật lại, sự kiện vẫn tới.

### Giai đoạn 2. Auth và khung admin (1 tuần)

- [ ] auth-service: chi nhánh, nhân viên, `UserBranch`, đăng nhập (bcrypt, rate limit bằng @nestjs/throttler trong bộ nhớ gateway), access token RS256, refresh token (hạn trượt + hạn tuyệt đối, xoay vòng, phát hiện dùng lại), đăng xuất, khoá tài khoản.
- [ ] Gateway: kiểm tra JWT, xoá header `x-user-*`, chuyển tiếp `Authorization` + correlationId.
- [ ] React: màn đăng nhập, interceptor refresh ngầm (một lần refresh tại một thời điểm), khung admin theo vai trò, quản lý chi nhánh và nhân viên.
- [ ] Phát `branch.created` (inventory tạo kho ở giai đoạn 3).

**Xong khi:** test e2e: đăng nhập → gọi API → token hết hạn → tự refresh → dùng lại refresh token cũ thì bị đá ra; STAFF gọi API của MANAGER bị 403; gọi thẳng port service từ ngoài không được.

## 4. Giai đoạn 3–5: inventory, POS, messaging + báo cáo

### Giai đoạn 3. Hàng hoá và kho (2–3 tuần)

- [ ] Kim loại và bảng giá: `Metal`, `MetalPrice` (chỉ ghi thêm), màn hình ADMIN nhập giá vàng/bạc nhiều lần trong ngày, phát `metal_price.changed`.
- [ ] Danh mục, mẫu (`Product` với `pricingType`, `trackingType`), biến thể (ni, độ dài), giá cố định / giá theo chi nhánh cho hàng thời trang.
- [ ] Kho: tự tạo khi nhận `branch.created`; `acceptsOnlineOrders`, `onlineBuffer`.
- [ ] Nhập hàng: phiếu nhập có cả dòng hàng có tem (cân từng chiếc: tổng trọng lượng, trọng lượng đá, tiền công, giá vốn) và dòng hàng theo số lượng; duyệt bằng `version`; tạo `JewelryItem` hoặc cộng `InventoryItem`; ghi sổ kho.
- [ ] In tem: mã tem, mẫu, tuổi vàng, trọng lượng.
- [ ] Kiểm kê: quét tem → danh sách thiếu/thừa; hàng số lượng điều chỉnh theo chênh lệch.
- [ ] AuditLog cho đổi giá, sửa trọng lượng, điều chỉnh kiểm kê.
- [ ] API nội bộ cho sales: `POST /stock/deduct`, `POST /stock/release` (idempotent theo `orderId`), `GET /items/by-tag/:code`, `GET /price-quote` (tính giá theo giá vàng hiện tại).

**Xong khi:** test đồng thời: hai quản lý cùng duyệt một phiếu → chỉ một lần nhập; hai request cùng giữ một tem → một thắng; 50 request trừ một mẫu thời trang còn 10 → đúng 10 thành công, tồn = 0; CHECK chặn số âm.

### Giai đoạn 4. Bán tại quầy (2 tuần)

- [ ] sales-service: tạo hoá đơn POS với `Idempotency-Key` + `requestHash`, chốt giá từng dòng (`metalPriceAtSale`, `metalWeight`, `laborFee`, `stoneFee`), gọi inventory trừ kho (timeout 3 s, retry theo `orderId`, `release` khi lỗi).
- [ ] Thanh toán chuyển khoản: VietQR theo mã hoá đơn, nhân viên bấm "Đã nhận tiền" (`AWAITING_PAYMENT → COMPLETED` có điều kiện), huỷ hoá đơn cộng lại kho.
- [ ] Khách hàng theo số điện thoại, lịch sử mua.
- [ ] Màn hình POS: quét tem / mã vạch, hiện giá theo giá vàng hiện tại, giỏ hàng có mã idempotency, lưu tạm giỏ khi phải đăng nhập lại.

**Xong khi:** test: bấm thanh toán 5 lần cùng một key → 1 hoá đơn; hai quầy cùng quét một tem → một quầy báo hết; "Đã nhận tiền" và "Huỷ" bấm cùng lúc → chỉ một bên thắng; tắt inventory giữa lúc bán → POS báo lỗi rõ trong 3 giây, không mất hàng.

### Giai đoạn 5. Sự kiện và báo cáo (1–2 tuần)

- [ ] sales phát `order.completed`, `order.cancelled` qua outbox; inventory phát `stock.changed`.
- [ ] report-service: `OrderRevenue`, `OrderLineSales` (upsert theo `orderId`), `InventorySnapshot` mỗi đêm; báo cáo doanh thu, lợi nhuận gộp, top sản phẩm, tồn kho theo số chỉ của từng tuổi vàng; xuất Excel.
- [ ] Màn hình DLQ cho admin: xem thư lỗi, đẩy lại.

**Xong khi:** test: gửi trùng một `order.completed` 3 lần → doanh thu không đổi; tắt report 10 phút trong lúc bán → bật lại, báo cáo tự đuổi kịp; một thư sai format vào DLQ và log có correlationId.

## 5. Giai đoạn 6–7: bán online, thu mua và đổi

### Giai đoạn 6. Bán online (2–3 tuần)

- [ ] inventory: `GET /stock/availability` (tổng còn bán được trên các kho nhận đơn online, giá tạm tính theo giá vàng hiện tại).
- [ ] Saga đơn online: `order.created` → chọn kho nhiều hàng nhất có đủ cả đơn → giữ hàng (hàng có tem: chọn chiếc cụ thể và chốt giá; hàng số lượng: tăng `reserved`) → `stock.reserved` / `stock.reserve_failed` → `AWAITING_PAYMENT` / `CANCELLED`.
- [ ] Job hết hạn giữ hàng mỗi phút; sales tự theo dõi đơn `PENDING` quá 10 / 30 phút; dấu `RELEASED` cho huỷ đến sớm.
- [ ] Webhook ngân hàng: xác minh chữ ký, `BankTransaction` unique `bankTxnRef`, ghép theo nội dung, đủ / thiếu / không ghép được; `order.paid` → gia hạn giữ hàng.
- [ ] Đóng gói và giao: danh sách đơn của chi nhánh được chọn, `CONFIRMED → PACKING → SHIPPING → COMPLETED`, trừ hẳn kho khi `SHIPPING`; huỷ và hoàn tiền theo bảng bù trừ.
- [ ] Website React: danh mục, chi tiết mẫu + ni + giá tạm tính, giỏ hàng, đặt hàng, trang chờ "Đang kiểm tra hàng…" (polling), QR + đếm ngược, tra cứu đơn.

**Xong khi:** test: 200 đơn online cùng tranh 20 chiếc → đúng 20 đơn giữ được, không chiếc nào bị giữ hai lần; gửi `order.created` trùng → giữ một lần; `order.cancelled` đến trước `order.created` → không giữ hàng; tiền về đúng lúc hết hạn → một bên thắng, không mất tiền khách; webhook gửi trùng → ghi nhận một lần.

### Giai đoạn 7. Thu mua và đổi (1–2 tuần)

- [ ] Phiếu thu mua: quét tem (hàng của cửa hàng) hoặc nhập tay (hàng ngoài), cân, chọn tuổi vàng, giá thu = trọng lượng × giá mua vào − khấu trừ theo cấu hình; `Payment(PAYOUT)` khi chuyển khoản trả khách.
- [ ] inventory nhận món thu vào: `JewelryItem(origin = BOUGHT_BACK)`, chọn bán lại hoặc `PENDING_MELT`; sổ kho `BUYBACK`.
- [ ] Đổi hàng: một hoá đơn có `OrderItem` (bán) và `TradeInItem` (thu vào), tính chênh lệch, khách trả thêm hoặc cửa hàng trả lại.
- [ ] Báo cáo: tổng thu mua theo ngày, lợi nhuận tách tiền công và chênh lệch giá vàng.

**Xong khi:** test: đổi hàng mà bước nhập món cũ lỗi → món mới được nhả, không có hoá đơn nửa vời; một tem đã thu mua không thể bị thu mua lần nữa; mọi phiếu thu mua có AuditLog.

## 6. Giai đoạn 8–9: gia cố, triển khai thật, go-live

### Giai đoạn 8. Gia cố (1–2 tuần)

- [ ] Job đối soát mỗi đêm: `reserved` khớp lượt giữ, sổ kho khớp tồn, lượt giữ của đơn đã huỷ, đơn kẹt.
- [ ] Thử tải giờ cao điểm: 3.000 đơn online trong 2 phút + 3 quầy bán liên tục; theo dõi độ dài queue, thời gian phản hồi POS, số lỗi.
- [ ] Rà soát bảo mật: chỉ gateway mở port; mỗi schema một user DB; `private.pem` chỉ ở auth; rate limit đăng nhập; webhook ngân hàng có chữ ký; không lộ stack trace; HTTPS.
- [ ] Sao lưu Postgres mỗi ngày (`pg_dump` ra nơi khác máy chủ) và **thử khôi phục thật** một lần.
- [ ] Giám sát tối thiểu: cảnh báo khi DLQ có thư, service `ready` đỏ quá 1 phút, queue dài bất thường, đối soát có chỗ lệch.
- [ ] Runbook: xử lý thư trong DLQ, khôi phục backup, đổi khoá JWT, khoá tài khoản nhân viên nghỉ việc.

### Giai đoạn 9. Triển khai và go-live (1–2 tuần)

1. **Môi trường:** staging và production tách riêng (hai máy hoặc hai VPS), cùng Docker Compose, khác `.env`; reverse proxy (Caddy hoặc Nginx) cấp HTTPS cho gateway và website.
2. **Quy trình phát hành:** CI build image có tag theo commit → deploy lên staging → chạy test e2e → deploy production; `prisma migrate deploy` chạy trước khi service mới nhận request; đổi format sự kiện chỉ theo kiểu thêm.
3. **Nhập dữ liệu ban đầu:** chi nhánh, nhân viên, danh mục, mẫu; kiểm kê thật từng chi nhánh, cân và in tem mới cho mọi chiếc đang có; tồn hàng thời trang theo số đếm.
4. **Đào tạo:** thu ngân (POS, thu mua, đổi), thủ kho (nhập, in tem, kiểm kê), quản lý (duyệt, giá vàng, báo cáo), nhân viên online (đóng gói, giao).
5. **Chạy thử một chi nhánh** 1–2 tuần song song với cách làm cũ; mỗi tối so doanh thu và tồn kho giữa hai cách.
6. **Mở dần:** các chi nhánh còn lại, rồi mới mở website bán online.
7. **Sau go-live:** 2 tuần đầu xem đối soát và DLQ mỗi sáng; ghi lỗi và yêu cầu mới vào danh sách, xử lý theo đợt.

## 7. Cách làm từng lát

### Quy trình một lát (ví dụ: "duyệt phiếu nhập")

1. **Viết đặc tả ngắn** trong tài liệu: API (đường dẫn, body, response, mã lỗi, vai trò), bảng bị ghi, sự kiện phát ra, các tình huống đồng thời áp dụng (ví dụ chương 3 tình huống 3 và 7).
2. **Giao cho Claude** đặc tả + phần liên quan của tài liệu thiết kế + `libs/contracts`; yêu cầu code **kèm test**, chỉ trong phạm vi lát đó.
3. **Đọc code theo checklist** bên dưới, không chỉ chạy thử bằng tay.
4. **Chạy test**, gồm test đồng thời của lát.
5. **Cập nhật tài liệu** nếu có quyết định mới; merge qua pull request vào nhánh chính.

### Các tầng test

| Tầng | Kiểm tra gì | Chạy với |
| --- | --- | --- |
| Unit | Tính giá, chuyển trạng thái hợp lệ, phân loại lỗi | Hàm thuần, không DB |
| Integration | Repository, transaction, UPDATE có điều kiện, unique | Postgres thật trong container (Testcontainers) |
| Đồng thời | Bán âm, trùng request, trùng thư, deadlock, đua trạng thái | Postgres + RabbitMQ thật, bắn song song bằng `Promise.all` |
| Contract | Payload sự kiện và API đúng `libs/contracts` / OpenAPI | Schema zod / OpenAPI |
| E2E | Luồng đầy đủ qua gateway: đăng nhập → bán → báo cáo | Docker Compose cả hệ thống |

### Definition of Done cho mỗi lát

- [ ] Đúng đặc tả; API khớp OpenAPI, sự kiện khớp contracts.
- [ ] Có test unit + integration; có test đồng thời nếu lát ghi vào dữ liệu dùng chung.
- [ ] Log có correlationId; lỗi trả đúng định dạng thống nhất; không lộ stack trace.
- [ ] Migration chạy được từ đầu trên database trống.
- [ ] Tài liệu thiết kế đã cập nhật.

### Checklist đọc code Claude viết

- [ ] Có chỗ nào **đọc rồi kiểm tra trong code rồi mới ghi** không? Phải là UPDATE có điều kiện hoặc `SELECT FOR UPDATE`.
- [ ] Các thao tác ghi đi cùng nhau có nằm trong **một transaction** không? Trong transaction có gọi HTTP, gửi message, chờ người dùng không (không được)?
- [ ] Nhiều dòng được khoá có **sắp theo `variantId` / id** không?
- [ ] Mọi việc có thể chạy lại (retry, thư giao lại, webhook) có **idempotent + unique constraint** không?
- [ ] Consumer có ghi `ProcessedEvent` **cùng transaction** với việc nghiệp vụ không? Có phân biệt lỗi tạm thời / vĩnh viễn / nghiệp vụ không?
- [ ] Sự kiện có đi qua **outbox**, không gửi thẳng lên RabbitMQ không?
- [ ] Đổi trạng thái có kiểm tra **trạng thái hiện tại** trong `WHERE` không?
- [ ] Giá và tên hàng trên hoá đơn có được **chép lại lúc bán** không?
- [ ] Có tin `branchId` / vai trò gửi từ client không (không được)?
- [ ] Tiền dùng `Decimal`, không dùng `number`?
