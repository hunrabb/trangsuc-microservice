# Thiết kế hệ thống quản lý chuỗi cửa hàng

> Tài liệu này trong repo là nguồn sự thật; mọi thay đổi thiết kế ghi vào đây.

Nov 4, 2026 · @khai

## 1. Tổng quan & kiến trúc

Hệ thống chia thành 4 service NestJS, mỗi service sở hữu một schema PostgreSQL riêng và giao tiếp bất đồng bộ qua RabbitMQ; inventory là nguồn sự thật duy nhất cho số lượng hàng.

**Phạm vi:** quản lý chi nhánh, nhân viên & phân quyền, sản phẩm, nhập kho, kiểm kê, tồn kho, bán hàng tại quầy (POS) thanh toán chuyển khoản, bán online qua website riêng (lấy hàng từ tất cả chi nhánh), báo cáo doanh thu. Không có điều chuyển hàng giữa các kho, không tích hợp sàn TMĐT ở phiên bản này.

**Tech stack**

| Tầng | Công nghệ | Vai trò |
| --- | --- | --- |
| Frontend | React (Vite, TanStack Query, React Router) | Web admin, màn hình POS, website bán hàng |
| Gateway | NestJS | Kiểm tra JWT, giới hạn số lần gọi, định tuyến request |
| Service | NestJS + Prisma | Nghiệp vụ, mỗi service một Prisma schema |
| CSDL | PostgreSQL 16 | 1 database, 4 schema (`auth`, `inventory`, `sales`, `report`), mỗi schema một user riêng |
| Message broker | RabbitMQ | Sự kiện domain, Saga, retry + dead-letter queue |
| Hạ tầng | Docker, Docker Compose | Mỗi service một container, chỉ gateway mở port ra ngoài |

**Danh sách service**

| Service | Trách nhiệm | Phát sự kiện | Nghe sự kiện |
| --- | --- | --- | --- |
| auth-service | Chi nhánh, nhân viên, vai trò, đăng nhập, cấp token | `branch.created` | — |
| inventory-service | Sản phẩm, biến thể, giá, kho, tồn kho, nhập hàng, kiểm kê, giữ hàng cho đơn online, chọn chi nhánh xuất đơn online | `stock.reserved`, `stock.reserve_failed`, `stock.reservation_expired`, `stock.changed`, `order.processing_failed` | `branch.created`, `order.created`, `order.cancelled`, `order.paid`, `order.shipping` |
| sales-service | Hoá đơn POS, đơn online, khách hàng, thanh toán chuyển khoản, hoàn tiền, trả hàng | `order.created`, `order.cancelled`, `order.paid`, `order.shipping`, `order.completed`, `order.returned` | `stock.*`, `order.processing_failed` |
| report-service | Tổng hợp doanh thu, lợi nhuận gộp, top sản phẩm, giá trị tồn kho | — | `order.completed`, `order.returned`, `stock.changed` |

Sản phẩm và tồn kho chung một service vì gần như mọi thao tác kho đều cần thông tin sản phẩm; nhờ vậy dùng được khoá ngoại thật và transaction chung. Các service khác chỉ lưu `branchId`, `variantId`… dạng ID và tin vào claim trong JWT.

&#91;embedded content: kiến trúc · 4 service, 1 message broker\]

Gateway định tuyến request đồng bộ; riêng POS gọi thẳng inventory để trừ kho ngay, còn mọi thay đổi khác lan sang service khác qua RabbitMQ.

## 2. Vai trò & phân quyền

Chỉ có 3 vai trò cố định (enum), gán theo chi nhánh; không có bảng quyền riêng, quyền của từng vai trò viết thẳng trong code.

**Mô hình:** `User` ↔ `UserBranch` (userId, branchId, role). Một nhân viên có thể có vai trò khác nhau ở từng chi nhánh. `ADMIN` có `branchId = null`, nghĩa là áp dụng toàn hệ thống.

| Vai trò | Phạm vi | Được làm gì |
| --- | --- | --- |
| ADMIN | Toàn hệ thống | Tất cả: chi nhánh, nhân viên, sản phẩm, giá, xem mọi báo cáo |
| MANAGER | 1 chi nhánh | Duyệt phiếu nhập, duyệt kiểm kê, quản lý nhân viên chi nhánh, xem báo cáo chi nhánh |
| STAFF | 1 chi nhánh | Lập hoá đơn POS, xác nhận đã nhận chuyển khoản, xử lý đơn online, tạo phiếu nhập (chờ duyệt) |

**Quy tắc kiểm tra quyền**

1. Gateway giải mã JWT, lấy danh sách `{branchId, role}` của người dùng.
2. Decorator `@Roles('MANAGER')` kiểm tra vai trò trên chi nhánh trong request; `ADMIN` luôn qua.
3. Service luôn thêm điều kiện `branchId IN (...)` vào truy vấn Prisma, không tin `branchId` gửi từ client.

### Xác thực (token)

|  | Access token | Refresh token |
| --- | --- | --- |
| Dạng | JWT ký RS256 | Chuỗi ngẫu nhiên 64 byte, không phải JWT |
| Nội dung | `sub` (userId), `branches[{branchId, role}]`, `iss`, `aud`, `iat`, `exp`; header có `kid` | Không chứa gì |
| Hạn | 15 phút | Hạn trượt 7 ngày (gia hạn mỗi lần refresh), hạn tuyệt đối 30 ngày tính từ `sessionStartedAt` |
| Client lưu | Biến trong bộ nhớ React | Cookie `httpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh` |
| Server lưu | Không lưu | Bản băm SHA-256 trong `auth.RefreshToken` |
| Ai kiểm tra | Gateway và mọi service, bằng public key, không gọi DB | Chỉ auth-service, tra DB |

**Khoá:** mỗi cặp khoá RSA 2048 có một `kid`, sinh bằng `pnpm keys:generate [kid]`. Private key ở `secrets/jwt/private/<kid>.private.pem`: chỉ auth-service được mount, và chỉ đúng file của `JWT_ACTIVE_KID` (đường dẫn trong `JWT_PRIVATE_KEY_PATH`). Public key ở `secrets/jwt/public/<kid>.public.pem`: gateway và mọi service mount cả thư mục, read-only, qua `JWT_PUBLIC_KEYS_DIR`. Hai thư mục tách riêng để mount thư mục public không thể kéo theo private key. Mỗi service nạp mọi `*.public.pem` lúc khởi động, `kid` là tên file; thiếu khoá, gặp private key trong thư mục public hoặc RSA dưới 2048 bit → service không bật. Đổi khoá bằng `kid`: thêm khoá mới → restart các service → đổi `JWT_ACTIVE_KID` để ký bằng khoá mới → sau 15 phút gỡ khoá cũ.

**Kiểm tra access token (gateway + mọi service):** dùng thư viện `jose`, ép `algorithms: ['RS256']`, chọn public key theo `kid` (`kid` thiếu hoặc lạ → từ chối), kiểm tra chữ ký trước, rồi `exp` (bắt buộc, lệch tối đa 30 giây), `nbf`, `iss`, `aud` (`JWT_ISSUER = auth-service`, `JWT_AUDIENCE = store-system`), rồi claims `sub`, `branches` bằng zod (`accessTokenClaimsSchema`). Hết hạn → `401 TOKEN_EXPIRED`; sai → `401 INVALID_TOKEN`. Gateway xoá mọi header `x-user-*` từ client và chuyển nguyên `Authorization` xuống service; service kiểm tra lại token (lớp bảo vệ thứ hai). Mọi endpoint mặc định cần đăng nhập, ngoại lệ đánh dấu `@Public()`.

**Định tuyến ở gateway** (`apps/gateway/src/proxy/routes.ts`):

| Đường ở gateway | Service | Đường ở service | Cần đăng nhập |
| --- | --- | --- | --- |
| `/api/auth/*` | auth | `/auth/*` | Không (login, refresh, logout) |
| `/api/pos/*` | sales | `/pos/*` | Có |
| `/api/online-orders/*` | sales | `/online-orders/*` | Có |
| `/api/shop/*` | sales | `/shop/*` | Không (website khách) |
| `/api/admin/auth/*` | auth | `/admin/*` | Có |
| `/api/admin/inventory/*` | inventory | `/admin/*` | Có |
| `/api/admin/sales/*` | sales | `/admin/*` | Có |
| `/api/admin/reports/*` | report | `/admin/*` | Có |
| `/webhooks/bank` | sales | `/webhooks/bank` | Không (kiểm chữ ký ở giai đoạn 6) |

Đường không có trong bảng → `404 NOT_FOUND`. `/internal/*` và `/health/*` của service không bao giờ được gateway chuyển tiếp. Đường cần đăng nhập: gateway kiểm tra token trước, sai thì trả lỗi luôn, không chuyển tiếp.

**Refresh:** băm cookie → tìm trong `RefreshToken` → kiểm tra tồn tại, chưa thu hồi, còn hạn trượt và hạn tuyệt đối, user `ACTIVE` → đọc lại vai trò mới nhất → thu hồi token cũ và phát token mới (xoay vòng) trong một transaction. Token đã thu hồi mà bị dùng lại → thu hồi mọi phiên của user đó.

**Frontend:** interceptor axios bắt `TOKEN_EXPIRED`, chỉ chạy một lần refresh tại một thời điểm (các request khác chờ chung), rồi gửi lại request; refresh hỏng → về màn đăng nhập, lưu tạm giỏ hàng POS. Refresh chủ động khoảng 1 phút trước `exp`.

**Đăng nhập:** bcrypt, thông báo lỗi chung "Sai email hoặc mật khẩu", tối đa 5 lần thử mỗi phút mỗi IP (thư viện @nestjs/throttler, đếm trong bộ nhớ gateway; chỉ chạy 1 instance gateway, khi nào chạy từ 2 instance mới thêm Redis). Khoá tài khoản → `status = LOCKED` + thu hồi mọi refresh token; access token đang dùng hết hiệu lực trong tối đa 15 phút.

## 3. Chức năng chi tiết theo module

Tổng cộng 8 module; mỗi module dưới đây liệt kê chức năng cho phiên bản đầu (MVP) và service sở hữu.

### 3.1 Chi nhánh (auth-service)

- CRUD chi nhánh: mã, tên, địa chỉ, SĐT, trạng thái hoạt động.
- Mỗi chi nhánh có đúng 1 kho (inventory tự tạo khi nhận `branch.created`); bật/tắt việc chi nhánh nhận đơn online.
- Gán quản lý chi nhánh.

### 3.2 Nhân viên & phân quyền (auth-service)

- Đăng nhập email/mật khẩu, JWT access 15 phút + refresh token 7 ngày, đăng xuất thu hồi refresh token.
- CRUD nhân viên, khoá/mở tài khoản, đổi mật khẩu.
- Gán nhân viên vào chi nhánh với vai trò ADMIN / MANAGER / STAFF.

### 3.3 Sản phẩm (inventory-service)

- Danh mục dạng cây, thương hiệu, đơn vị tính.
- Sản phẩm có nhiều biến thể (màu, size…); mỗi biến thể là một SKU có mã vạch riêng.
- Giá bán mặc định + giá riêng theo chi nhánh; lịch sử thay đổi giá.
- Ảnh sản phẩm, import/export Excel.

### 3.4 Nhà cung cấp & nhập kho (inventory-service)

- CRUD nhà cung cấp.
- Phiếu nhập: nháp → chờ duyệt → đã nhập kho / huỷ. Chỉ khi duyệt mới cộng tồn.
- Ghi giá vốn từng dòng, tính giá vốn bình quân gia quyền sau mỗi lần nhập.
- Theo dõi công nợ nhà cung cấp (số đã trả / còn nợ).

### 3.5 Tồn kho (inventory-service)

- Xem tồn theo kho / chi nhánh / SKU: tồn thực (`onHand`), đang giữ (`reserved`), khả dụng = `onHand − reserved`.
- Sổ kho (stock ledger): mọi biến động ghi một dòng, không sửa không xoá.
- Kiểm kê: tạo phiếu kiểm, nhập số thực tế, duyệt để điều chỉnh chênh lệch.
- Cảnh báo tồn dưới mức tối thiểu.

### 3.6 Bán hàng tại quầy – hoá đơn POS (sales-service)

- Quét mã vạch, tìm sản phẩm, giỏ hàng, giảm giá theo dòng / theo hoá đơn.
- Khách hàng (tìm theo SĐT, không bắt buộc).
- Thanh toán **chỉ bằng chuyển khoản**: hiện mã VietQR có sẵn số tiền + mã hoá đơn trong nội dung; thu ngân bấm "Đã nhận tiền" (sau này có thể tự xác nhận qua webhook ngân hàng).
- In / gửi hoá đơn, trả hàng và hoàn tiền bằng chuyển khoản (cộng lại tồn).

### 3.7 Bán hàng online qua website (sales-service + inventory-service)

- Website hiển thị số còn bán được = tổng `onHand − reserved − onlineBuffer` của mọi chi nhánh nhận đơn online.
- Khách đặt hàng, nhập thông tin giao hàng; đơn chưa gắn kho cho tới khi giữ được hàng.
- Hệ thống tự chọn **một** chi nhánh có đủ cả đơn, ưu tiên chi nhánh còn nhiều hàng nhất; không tách đơn. Không chi nhánh nào đủ → huỷ đơn, báo hết hàng.
- Thanh toán chuyển khoản qua VietQR, ghi nhận tự động qua webhook biến động số dư (hoặc nhân viên bấm xác nhận); giữ hàng tối đa 30 phút chờ thanh toán.
- Nhân viên chi nhánh được chọn xử lý đơn: đóng gói → giao → hoàn thành; khách huỷ / trả hàng theo bảng trạng thái ở mục 4.3.

### 3.8 Báo cáo (report-service)

- Doanh thu theo ngày / tuần / tháng, theo chi nhánh, theo kênh.
- Lợi nhuận gộp = doanh thu − giá vốn hàng bán.
- Top sản phẩm bán chạy, hàng tồn lâu, giá trị tồn kho.
- Báo cáo nhập – xuất – tồn theo kỳ; xuất Excel.

## 4. Luồng nghiệp vụ chính

Mọi luồng làm thay đổi tồn kho đều đi qua inventory-service và kết thúc bằng một dòng trong sổ kho; các service khác chỉ gửi yêu cầu hoặc nghe sự kiện.

### 4.1 Nhập kho

1. Thủ kho tạo phiếu nhập (`DRAFT`), chọn nhà cung cấp, thêm SKU, số lượng, giá nhập.
2. Gửi duyệt → `PENDING`.
3. Quản lý duyệt (kèm `version` đang thấy) → trong **một transaction**: đổi phiếu sang `COMPLETED` có điều kiện `version`, khoá từng dòng tồn bằng `SELECT … FOR UPDATE` (sắp theo `variantId`), cộng `onHand`, tính lại giá vốn bình quân, ghi `StockMovement(IMPORT)`, ghi outbox `stock.changed`.
4. Lệch `version` → `409 VERSION_CONFLICT`, không cộng kho. Report nhận `stock.changed` để cập nhật giá trị tồn.

### 4.2 Bán hàng tại quầy – hoá đơn POS (gọi trực tiếp)

1. Thu ngân quét hàng, POS gọi `POST /orders` kèm header `Idempotency-Key` (mã chống gửi trùng, xem mục 7).
2. sales-service gọi thẳng inventory-service để **trừ kho có điều kiện**: chỉ trừ khi còn đủ hàng.
3. Đủ hàng → tạo hoá đơn trạng thái `AWAITING_PAYMENT`, hiện mã VietQR. Thiếu hàng → báo "không đủ hàng", không tạo hoá đơn.
4. Thu ngân bấm "Đã nhận tiền" → hoá đơn `COMPLETED`, in hoá đơn. Khách không chuyển khoản / huỷ → hoá đơn `CANCELLED`, inventory cộng lại số đã trừ.
5. Ở quầy dùng gọi trực tiếp (chờ kết quả ngay) vì khách đang đứng chờ.

### 4.3 Đơn online (Saga qua RabbitMQ)

Đơn online không gắn sẵn kho: inventory chọn **một** chi nhánh đủ cả đơn, ưu tiên chi nhánh còn nhiều hàng nhất, rồi giữ hàng ở đó. Các bước nối nhau bằng sự kiện; bước nào hỏng thì bước trước được hoàn tác.

**Trạng thái đơn online**

| Từ | Được sang | Khi nào |
| --- | --- | --- |
| PENDING | AWAITING\_PAYMENT, CANCELLED | Giữ được hàng / hết hàng hoặc khách huỷ |
| AWAITING\_PAYMENT | CONFIRMED, CANCELLED | Nhận đủ tiền / quá hạn 30 phút hoặc khách huỷ |
| CONFIRMED | PACKING, CANCELLED | Nhân viên bắt đầu đóng gói / khách huỷ (hoàn tiền) |
| PACKING | SHIPPING, CANCELLED | Giao cho vận chuyển / quản lý duyệt huỷ (hoàn tiền) |
| SHIPPING | COMPLETED, RETURNED | Khách nhận / hoàn hàng |
| COMPLETED | RETURNED | Trả hàng sau khi nhận |

Mọi lần chuyển trạng thái là `UPDATE … WHERE id = ? AND status IN (<các trạng thái được phép>)`; 0 dòng → bỏ qua hoặc trả `409 INVALID_STATE`.

**Các bước**

1. **Tạo đơn (sales):** website gọi `POST /orders` (có `Idempotency-Key`). Một transaction: tạo `Order(PENDING, warehouseId = null)` + outbox `order.created { orderId, items }`. Website hiện "Đang kiểm tra hàng…" và hỏi lại trạng thái mỗi 1–2 giây.
2. **Chọn kho và giữ hàng (inventory):** nhận `order.created`.
   - Lấy các kho có `acceptsOnlineOrders = true` mà **mỗi** món của đơn đều có `onHand − reserved − onlineBuffer ≥ quantity`.
   - Xếp các kho theo **tổng số còn bán được online của các món trong đơn**, giảm dần (kho nhiều hàng nhất trước); bằng nhau thì theo `code`.
   - Thử kho đầu tiên: một transaction gồm ghi `ProcessedEvent`, giữ từng món bằng `UPDATE … SET reserved = reserved + qty WHERE … AND onHand − reserved − onlineBuffer >= qty` (sắp theo `variantId`), tạo `StockReservation(ACTIVE, expiresAt = now + 30 phút)`, ghi outbox `stock.reserved { orderId, warehouseId, branchId }`.
   - Có món trả về 0 dòng (vừa bị quầy bán mất) → rollback, thử kho tiếp theo.
   - Hết kho để thử → transaction mới: `ProcessedEvent` + outbox `stock.reserve_failed { orderId, missing[] }`.
3. **Chờ thanh toán (sales):** nhận `stock.reserved` → `PENDING → AWAITING_PAYMENT`, lưu `warehouseId` và `fulfillingBranchId`; website hiện mã VietQR (nội dung = mã đơn) và đếm ngược 25 phút. Nhận `stock.reserve_failed` → `CANCELLED`, báo hết hàng.
4. **Nhận tiền (sales):** webhook ngân hàng → xác minh chữ ký → lưu `BankTransaction` (unique `bankTxnRef`) → ghép theo nội dung. Đủ tiền → `AWAITING_PAYMENT → CONFIRMED`, ghi `Payment`, outbox `order.paid`. Thiếu tiền → giữ nguyên trạng thái, báo khách. Không ghép được → để nhân viên ghép tay.
5. **Gia hạn giữ hàng (inventory):** nhận `order.paid` → gia hạn `expiresAt` thêm 3 ngày. Nếu lượt giữ đã `EXPIRED` → thử giữ lại ở cùng kho, thất bại thì phát `stock.reserve_failed` để sales huỷ và hoàn tiền.
6. **Đóng gói và giao (nhân viên chi nhánh được chọn):** `CONFIRMED → PACKING → SHIPPING`. Khi sang `SHIPPING`, outbox `order.shipping`; inventory chuyển lượt giữ sang `CONSUMED`, trừ `onHand` và `reserved`, ghi `StockMovement(SALE)`.
7. **Hoàn thành:** `SHIPPING → COMPLETED`, outbox `order.completed` cho report.

**Hoàn tác (bù trừ)**

| Sự kiện | Việc hoàn tác |
| --- | --- |
| Hết hàng ở mọi kho | Huỷ đơn (chưa thu tiền nên không hoàn tiền) |
| Quá 30 phút chưa trả tiền | Job mỗi phút: `UPDATE StockReservation SET status = 'EXPIRED' WHERE … AND status = 'ACTIVE'`, nhả `reserved`, phát `stock.reservation_expired` → sales huỷ đơn |
| Khách huỷ trước khi giao | Sales phát `order.cancelled` → inventory nhả hàng; đã trả tiền thì tạo `Payment(REFUND_PENDING)` |
| Hoàn hàng / trả hàng | Hàng về kho → cộng `onHand` (`RETURN`), hoàn tiền, phát `order.returned` |
| Huỷ đến trước khi đơn được giữ hàng | Inventory ghi `StockReservation(RELEASED, quantity = 0)` làm dấu; `order.created` đến sau thấy dấu thì bỏ qua |

## 5. Thiết kế CSDL

1 database PostgreSQL, 4 schema, khoảng 30 bảng; mỗi schema chỉ user của service sở hữu được đọc/ghi. Không có khoá ngoại xuyên schema — tham chiếu sang service khác chỉ lưu ID (UUID), dữ liệu cần hiển thị được chép lại lúc ghi (ví dụ tên, giá sản phẩm trên dòng hoá đơn).

**Quy ước chung:** khoá chính `id UUID`; mọi bảng có `createdAt`, `updatedAt`; bảng nghiệp vụ chính có `deletedAt` (xoá mềm) và `version INT` (khoá lạc quan); tiền lưu `DECIMAL(15,2)`, số lượng `INT`; mỗi schema có bảng `OutboxEvent` và `ProcessedEvent`.

### 5.1 Schema `auth`

```
Branch 1 ──< UserBranch >── 1 User 1 ──< RefreshToken
```

| Bảng | Cột chính | Ghi chú |
| --- | --- | --- |
| Branch | code (unique), name, address, phone, isActive | Chi nhánh |
| User | email (unique), passwordHash, fullName, phone, status (`ACTIVE`, `LOCKED`) | Nhân viên |
| UserBranch | userId, branchId (null = toàn hệ thống), role (`ADMIN`, `MANAGER`, `STAFF`) | Unique (userId, branchId) |
| RefreshToken | userId, tokenHash (unique), expiresAt (hạn trượt), sessionStartedAt (hạn tuyệt đối), revokedAt | Phiên đăng nhập |

### 5.2 Schema `inventory` (sản phẩm + kho)

```
Category 1 ──< Category (cây)        Brand 1 ──< Product
Category 1 ──< Product 1 ──< ProductVariant 1 ──< BranchPrice / PriceHistory
               Product 1 ──< ProductImage
Warehouse (→ auth.Branch) 1 ──< InventoryItem >── 1 ProductVariant
Warehouse 1 ──< StockMovement / StockReservation (→ sales.Order)
Supplier 1 ──< GoodsReceipt 1 ──< GoodsReceiptItem
StockCount 1 ──< StockCountItem
```

| Bảng | Cột chính | Ghi chú |
| --- | --- | --- |
| Category | name, slug (unique), parentId | Cây danh mục |
| Brand | name (unique) |  |
| Product | name, slug, categoryId, brandId, unit, description, status | Sản phẩm gốc |
| ProductVariant | productId, sku (unique), barcode (unique), attributes (JSONB), basePrice | Đơn vị bán & đếm tồn |
| BranchPrice | variantId, branchId, price | Unique (variantId, branchId) |
| PriceHistory | variantId, branchId, oldPrice, newPrice, changedBy | Chỉ ghi thêm |
| ProductImage | productId, url, sortOrder |  |
| Warehouse | branchId (unique), code (unique), name, acceptsOnlineOrders | Mỗi chi nhánh 1 kho |
| InventoryItem | warehouseId, variantId, onHand, reserved, onlineBuffer, minQty, avgCost, version | Unique (warehouseId, variantId); CHECK onHand ≥ 0, reserved ≥ 0, reserved ≤ onHand, onlineBuffer ≥ 0 |
| StockMovement | warehouseId, variantId, type (`IMPORT`, `SALE`, `SALE_CANCEL`, `RETURN`, `ADJUSTMENT`), quantity (±), balanceAfter, unitCost, refType, refId | Sổ kho, chỉ ghi thêm; unique (refType, refId, variantId, type) |
| Supplier | code (unique), name, phone, taxCode, debt |  |
| GoodsReceipt | code, warehouseId, supplierId, status, totalAmount, paidAmount, approvedBy, version | Phiếu nhập |
| GoodsReceiptItem | receiptId, variantId, quantity, unitCost | CHECK quantity > 0 |
| StockReservation | warehouseId, variantId, orderId, quantity, status (`ACTIVE`, `CONSUMED`, `RELEASED`, `EXPIRED`), expiresAt | Unique (orderId, variantId); `RELEASED` với quantity 0 = dấu "đơn đã huỷ" |
| StockCount | code, warehouseId, status, version | Phiếu kiểm kê |
| StockCountItem | countId, variantId, systemQty (chụp lúc bắt đầu đếm), actualQty | Điều chỉnh theo chênh lệch |

**Số còn bán được:** tại quầy = `onHand − reserved`; trên website = `onHand − reserved − onlineBuffer` (tổng các kho `acceptsOnlineOrders`).

### 5.3 Schema `sales`

```
Customer 1 ──< Order (→ auth.Branch, → inventory.Warehouse)
                 ├──< OrderItem (→ inventory.ProductVariant)
                 ├──< OrderStatusHistory
                 ├──< Payment >── 0..1 BankTransaction
                 └──< ReturnOrder 1 ──< ReturnItem
```

| Bảng | Cột chính | Ghi chú |
| --- | --- | --- |
| Customer | phone (unique), name, email, address, totalSpent |  |
| Order | code (unique, = nội dung chuyển khoản), channel (`POS`, `WEBSITE`), status, branchId, warehouseId (null khi online `PENDING`), fulfillingBranchId, customerId, subtotal, discount, shippingFee, total, idempotencyKey (unique), requestHash, recipientName, recipientPhone, shippingAddress, createdBy, version | Hoá đơn POS và đơn online chung bảng |
| OrderItem | orderId, variantId, sku, productName, unitPrice, quantity, discount, unitCost | Chép tên/giá lúc bán; CHECK quantity > 0 |
| OrderStatusHistory | orderId, fromStatus, toStatus, changedBy, note | Chỉ ghi thêm |
| BankTransaction | bankTxnRef (unique), amount, content, receivedAt, matchedOrderId (null = chưa ghép) | Mọi tiền vào từ webhook ngân hàng |
| Payment | orderId, type (`PAYMENT`, `REFUND`), amount, status (`PENDING`, `CONFIRMED`, `REFUND_PENDING`, `REFUNDED`), bankTransactionId, confirmedBy, confirmedAt |  |
| ReturnOrder / ReturnItem | orderId, reason, refundAmount / variantId, quantity | Trả hàng |

### 5.4 Schema `report`

| Bảng | Cột chính | Ghi chú |
| --- | --- | --- |
| OrderRevenue | orderId (unique), date, branchId, channel, revenue, cogs, status (`COMPLETED`, `RETURNED`) | Ghi bằng upsert theo orderId |
| OrderLineSales | orderId, variantId, sku, productName, quantity, revenue | Unique (orderId, variantId); dùng cho top sản phẩm |
| InventorySnapshot | date, warehouseId, variantId, onHand, value | Unique (date, warehouseId, variantId); chụp cuối ngày |

Doanh thu, lợi nhuận gộp theo ngày / chi nhánh / kênh = `SUM` trên `OrderRevenue`; không cộng dồn vào bảng tổng.

### 5.5 Bảng dùng chung ở mọi schema

| Bảng | Cột chính | Ghi chú |
| --- | --- | --- |
| OutboxEvent | aggregateType, aggregateId, eventType, payload (JSONB), status, attempts, publishedAt | Ghi cùng transaction nghiệp vụ |
| ProcessedEvent | eventId (PK), consumer, processedAt | Chống xử lý trùng |

## 6. Prisma schema (service lõi)

Schema đầy đủ cho auth, inventory và sales; report viết theo bảng ở mục 5.4. Mỗi service có `OutboxEvent` và `ProcessedEvent` như ở 6.2 (auth chỉ cần `OutboxEvent`). Các CHECK constraint thêm bằng migration SQL viết tay.

### 6.1 auth-service

```prisma
enum UserStatus { ACTIVE LOCKED }
enum Role { ADMIN MANAGER STAFF }

model Branch {
  id        String       @id @default(uuid()) @db.Uuid
  code      String       @unique
  name      String
  address   String?
  phone     String?
  isActive  Boolean      @default(true)
  members   UserBranch[]
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt
}

model User {
  id           String         @id @default(uuid()) @db.Uuid
  email        String         @unique
  passwordHash String
  fullName     String
  phone        String?
  status       UserStatus     @default(ACTIVE)
  branches     UserBranch[]
  tokens       RefreshToken[]
  createdAt    DateTime       @default(now())
  updatedAt    DateTime       @updatedAt
}

model UserBranch {
  id       String  @id @default(uuid()) @db.Uuid
  userId   String  @db.Uuid
  branchId String? @db.Uuid // null = ADMIN toàn hệ thống
  role     Role
  user     User    @relation(fields: [userId], references: [id])
  branch   Branch? @relation(fields: [branchId], references: [id])
  @@unique([userId, branchId])
}

model RefreshToken {
  id               String    @id @default(uuid()) @db.Uuid
  userId           String    @db.Uuid
  tokenHash        String    @unique
  expiresAt        DateTime  // hạn trượt 7 ngày
  sessionStartedAt DateTime  // giữ nguyên qua mọi lần xoay vòng → hạn tuyệt đối 30 ngày
  revokedAt        DateTime?
  user             User      @relation(fields: [userId], references: [id])
  createdAt        DateTime  @default(now())
  @@index([userId])
}
```

### 6.2 inventory-service (sản phẩm + kho)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL") // ?schema=inventory
}

generator client {
  provider = "prisma-client-js"
}

enum ProductStatus { ACTIVE INACTIVE }
enum MovementType  { IMPORT SALE SALE_CANCEL RETURN ADJUSTMENT }
enum ReceiptStatus { DRAFT PENDING COMPLETED CANCELLED }
enum ReservationStatus { ACTIVE CONSUMED RELEASED EXPIRED }
enum CountStatus { DRAFT COMPLETED }
enum OutboxStatus { PENDING PUBLISHED FAILED }

// ---------- Sản phẩm ----------
model Category {
  id       String     @id @default(uuid()) @db.Uuid
  name     String
  slug     String     @unique
  parentId String?    @db.Uuid
  parent   Category?  @relation("CategoryTree", fields: [parentId], references: [id])
  children Category[] @relation("CategoryTree")
  products Product[]
}

model Brand {
  id       String    @id @default(uuid()) @db.Uuid
  name     String    @unique
  products Product[]
}

model Product {
  id          String           @id @default(uuid()) @db.Uuid
  name        String
  slug        String           @unique
  categoryId  String           @db.Uuid
  brandId     String?          @db.Uuid
  unit        String
  description String?
  status      ProductStatus    @default(ACTIVE)
  category    Category         @relation(fields: [categoryId], references: [id])
  brand       Brand?           @relation(fields: [brandId], references: [id])
  variants    ProductVariant[]
  images      ProductImage[]
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt
  deletedAt   DateTime?
}

model ProductVariant {
  id           String          @id @default(uuid()) @db.Uuid
  productId    String          @db.Uuid
  sku          String          @unique
  barcode      String?         @unique
  attributes   Json            // { "màu": "đỏ", "size": "M" }
  basePrice    Decimal         @db.Decimal(15, 2)
  product      Product         @relation(fields: [productId], references: [id])
  branchPrices BranchPrice[]
  stocks       InventoryItem[]
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt
  deletedAt    DateTime?
}

model BranchPrice {
  id        String         @id @default(uuid()) @db.Uuid
  variantId String         @db.Uuid
  branchId  String         @db.Uuid // → auth.Branch
  price     Decimal        @db.Decimal(15, 2)
  variant   ProductVariant @relation(fields: [variantId], references: [id])
  @@unique([variantId, branchId])
}

model PriceHistory {
  id        String   @id @default(uuid()) @db.Uuid
  variantId String   @db.Uuid
  branchId  String?  @db.Uuid
  oldPrice  Decimal  @db.Decimal(15, 2)
  newPrice  Decimal  @db.Decimal(15, 2)
  changedBy String   @db.Uuid
  createdAt DateTime @default(now())
}

model ProductImage {
  id        String  @id @default(uuid()) @db.Uuid
  productId String  @db.Uuid
  url       String
  sortOrder Int     @default(0)
  product   Product @relation(fields: [productId], references: [id], onDelete: Cascade)
}

// ---------- Kho ----------
model Warehouse {
  id                  String          @id @default(uuid()) @db.Uuid
  branchId            String          @unique @db.Uuid // mỗi chi nhánh 1 kho
  code                String          @unique
  name                String
  acceptsOnlineOrders Boolean         @default(true)
  items               InventoryItem[]
  createdAt           DateTime        @default(now())
  updatedAt           DateTime        @updatedAt
}

model InventoryItem {
  id           String         @id @default(uuid()) @db.Uuid
  warehouseId  String         @db.Uuid
  variantId    String         @db.Uuid
  onHand       Int            @default(0) // hàng thực có
  reserved     Int            @default(0) // đang giữ cho đơn online
  onlineBuffer Int            @default(0) // luôn để lại cho quầy
  minQty       Int            @default(0)
  avgCost      Decimal        @default(0) @db.Decimal(15, 2)
  version      Int            @default(0)
  warehouse    Warehouse      @relation(fields: [warehouseId], references: [id])
  variant      ProductVariant @relation(fields: [variantId], references: [id])
  updatedAt    DateTime       @updatedAt
  @@unique([warehouseId, variantId])
  @@index([variantId])
  // CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand AND online_buffer >= 0)
}

model StockMovement {
  id           String       @id @default(uuid()) @db.Uuid
  warehouseId  String       @db.Uuid
  variantId    String       @db.Uuid
  type         MovementType
  quantity     Int          // dương = vào kho, âm = ra kho
  balanceAfter Int
  unitCost     Decimal      @db.Decimal(15, 2)
  refType      String       // GOODS_RECEIPT | ORDER | STOCK_COUNT
  refId        String       @db.Uuid
  createdBy    String?      @db.Uuid
  createdAt    DateTime     @default(now())
  @@unique([refType, refId, variantId, type]) // chống trừ trùng theo orderId
  @@index([warehouseId, variantId, createdAt])
}

model Supplier {
  id       String         @id @default(uuid()) @db.Uuid
  code     String         @unique
  name     String
  phone    String?
  taxCode  String?
  debt     Decimal        @default(0) @db.Decimal(15, 2)
  receipts GoodsReceipt[]
}

model GoodsReceipt {
  id          String             @id @default(uuid()) @db.Uuid
  code        String             @unique
  warehouseId String             @db.Uuid
  supplierId  String             @db.Uuid
  status      ReceiptStatus      @default(DRAFT)
  totalAmount Decimal            @default(0) @db.Decimal(15, 2)
  paidAmount  Decimal            @default(0) @db.Decimal(15, 2)
  note        String?
  createdBy   String             @db.Uuid
  approvedBy  String?            @db.Uuid
  approvedAt  DateTime?
  version     Int                @default(0)
  supplier    Supplier           @relation(fields: [supplierId], references: [id])
  items       GoodsReceiptItem[]
  createdAt   DateTime           @default(now())
  updatedAt   DateTime           @updatedAt
  @@index([warehouseId, status])
}

model GoodsReceiptItem {
  id        String       @id @default(uuid()) @db.Uuid
  receiptId String       @db.Uuid
  variantId String       @db.Uuid
  quantity  Int
  unitCost  Decimal      @db.Decimal(15, 2)
  receipt   GoodsReceipt @relation(fields: [receiptId], references: [id], onDelete: Cascade)
}

model StockReservation {
  id          String            @id @default(uuid()) @db.Uuid
  warehouseId String            @db.Uuid
  variantId   String            @db.Uuid
  orderId     String            @db.Uuid // → sales.Order
  quantity    Int
  status      ReservationStatus @default(ACTIVE)
  expiresAt   DateTime
  createdAt   DateTime          @default(now())
  updatedAt   DateTime          @updatedAt
  @@unique([orderId, variantId])
  @@index([status, expiresAt])
}

model StockCount {
  id          String           @id @default(uuid()) @db.Uuid
  code        String           @unique
  warehouseId String           @db.Uuid
  status      CountStatus      @default(DRAFT)
  version     Int              @default(0)
  items       StockCountItem[]
  createdBy   String           @db.Uuid
  createdAt   DateTime         @default(now())
}

model StockCountItem {
  id        String     @id @default(uuid()) @db.Uuid
  countId   String     @db.Uuid
  variantId String     @db.Uuid
  systemQty Int        // chụp lúc bắt đầu đếm món này
  actualQty Int?
  count     StockCount @relation(fields: [countId], references: [id], onDelete: Cascade)
}

// ---------- Nhất quán dữ liệu ----------
model OutboxEvent {
  id            String       @id @default(uuid()) @db.Uuid // = eventId
  aggregateType String
  aggregateId   String       @db.Uuid
  eventType     String
  payload       Json
  status        OutboxStatus @default(PENDING)
  attempts      Int          @default(0)
  createdAt     DateTime     @default(now())
  publishedAt   DateTime?
  @@index([status, createdAt])
}

model ProcessedEvent {
  eventId     String   @id @db.Uuid
  consumer    String
  processedAt DateTime @default(now())
}
```

### 6.3 sales-service

```prisma
enum SalesChannelType { POS WEBSITE }
enum OrderStatus { PENDING AWAITING_PAYMENT CONFIRMED PACKING SHIPPING COMPLETED CANCELLED RETURNED }
enum PaymentType { PAYMENT REFUND }
enum PaymentStatus { PENDING CONFIRMED REFUND_PENDING REFUNDED }

model Customer {
  id         String   @id @default(uuid()) @db.Uuid
  phone      String   @unique
  name       String
  email      String?
  address    String?
  totalSpent Decimal  @default(0) @db.Decimal(15, 2)
  orders     Order[]
  createdAt  DateTime @default(now())
}

model Order {
  id                 String           @id @default(uuid()) @db.Uuid
  code               String           @unique // = nội dung chuyển khoản
  channel            SalesChannelType
  status             OrderStatus
  branchId           String?          @db.Uuid // POS: chi nhánh bán; online: = fulfillingBranchId
  warehouseId        String?          @db.Uuid // online: null cho tới khi giữ được hàng
  fulfillingBranchId String?          @db.Uuid
  customerId         String?          @db.Uuid
  subtotal           Decimal          @db.Decimal(15, 2)
  discount           Decimal          @default(0) @db.Decimal(15, 2)
  shippingFee        Decimal          @default(0) @db.Decimal(15, 2)
  total              Decimal          @db.Decimal(15, 2)
  idempotencyKey     String           @unique
  requestHash        String           // băm body để phát hiện dùng lại key với nội dung khác
  recipientName      String?
  recipientPhone     String?
  shippingAddress    String?
  createdBy          String?          @db.Uuid
  version            Int              @default(0)
  customer           Customer?        @relation(fields: [customerId], references: [id])
  items              OrderItem[]
  payments           Payment[]
  history            OrderStatusHistory[]
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt
  @@index([branchId, createdAt])
  @@index([fulfillingBranchId, status])
  @@index([status, createdAt])
}

model OrderItem {
  id          String   @id @default(uuid()) @db.Uuid
  orderId     String   @db.Uuid
  variantId   String   @db.Uuid
  sku         String
  productName String
  unitPrice   Decimal  @db.Decimal(15, 2)
  quantity    Int
  discount    Decimal  @default(0) @db.Decimal(15, 2)
  unitCost    Decimal? @db.Decimal(15, 2)
  order       Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)
}

model OrderStatusHistory {
  id         String       @id @default(uuid()) @db.Uuid
  orderId    String       @db.Uuid
  fromStatus OrderStatus?
  toStatus   OrderStatus
  changedBy  String?      @db.Uuid
  note       String?
  order      Order        @relation(fields: [orderId], references: [id])
  createdAt  DateTime     @default(now())
}

model BankTransaction {
  id             String    @id @default(uuid()) @db.Uuid
  bankTxnRef     String    @unique // chống ghi nhận 2 lần khi webhook gửi trùng
  amount         Decimal   @db.Decimal(15, 2)
  content        String
  receivedAt     DateTime
  matchedOrderId String?   @db.Uuid // null = chưa ghép được, chờ nhân viên
  payments       Payment[]
  createdAt      DateTime  @default(now())
}

model Payment {
  id                String           @id @default(uuid()) @db.Uuid
  orderId           String           @db.Uuid
  type              PaymentType      @default(PAYMENT)
  amount            Decimal          @db.Decimal(15, 2)
  status            PaymentStatus    @default(PENDING)
  bankTransactionId String?          @db.Uuid
  confirmedBy       String?          @db.Uuid
  confirmedAt       DateTime?
  order             Order            @relation(fields: [orderId], references: [id])
  bankTransaction   BankTransaction? @relation(fields: [bankTransactionId], references: [id])
  createdAt         DateTime         @default(now())
}
```

## 7. Xử lý đồng thời & nhất quán dữ liệu

Trong một service dùng transaction + cập nhật có điều kiện để không bao giờ bán âm kho; giữa các service dùng Outbox + Saga + consumer idempotent để đạt nhất quán cuối cùng mà không mất hay lặp sự kiện.

### 7.1 Chống bán âm kho (trong inventory-service)

Trừ tồn bằng một câu `UPDATE` nguyên tử có điều kiện, thay vì đọc rồi ghi:

```sql
UPDATE inventory."InventoryItem"
SET "onHand" = "onHand" - $qty, version = version + 1
WHERE "warehouseId" = $wh AND "variantId" = $variant
  AND "onHand" - reserved >= $qty;
-- affected rows = 0  =>  không đủ hàng, rollback
```

- Đơn nhiều dòng: sắp xếp các dòng theo `variantId` trước khi cập nhật để mọi transaction khoá cùng thứ tự, tránh deadlock.
- Gói cập nhật tồn + ghi `StockMovement` + ghi `OutboxEvent` trong `prisma.$transaction` (isolation `ReadCommitted` là đủ vì điều kiện nằm ngay trong `WHERE`).
- Ràng buộc `CHECK (onHand >= 0 AND reserved <= onHand)` ở DB là lưới an toàn cuối.
- Phiếu nhập, phiếu kiểm kê, đơn hàng dùng khoá lạc quan: `UPDATE … WHERE id = ? AND version = ?`; lệch version → trả 409 để client tải lại (ví dụ hai quản lý cùng bấm duyệt).

### 7.2 Transactional Outbox

1. Service ghi dữ liệu nghiệp vụ và `OutboxEvent(PENDING)` trong cùng một transaction.
2. Worker relay mỗi 500 ms lấy lô sự kiện bằng `SELECT … FOR UPDATE SKIP LOCKED LIMIT 100`, publish lên RabbitMQ với publisher confirm, rồi đặt `PUBLISHED`.
3. Lỗi publish → tăng `attempts`, quá 10 lần → `FAILED` và cảnh báo.

Nhờ vậy không có trường hợp DB đã commit mà sự kiện bị mất, hoặc sự kiện đã gửi mà DB rollback.

### 7.3 Consumer idempotent, retry và DLQ

- Mỗi thư mang `eventId` (= id dòng outbox). Consumer ghi `ProcessedEvent(eventId)` trong **cùng transaction** với việc nghiệp vụ; trùng khoá (`P2002` trên `eventId`) → bỏ qua và vẫn ack. Lớp thứ hai chống trùng *việc*: unique theo `orderId` (`StockReservation`, `StockMovement`, `OrderRevenue`).
- Manual ack sau khi commit; `prefetch = 10`, nhỏ hơn `connection_limit` của Prisma.
- Lỗi tạm thời (DB bận, timeout, `40P01`) → nack sang queue chờ có TTL 5 s → 30 s → 5 phút (đếm bằng header `x-death`); quá 3 lần → DLQ. Lỗi vĩnh viễn (sai format, không tìm thấy dữ liệu) → DLQ ngay. Lỗi nghiệp vụ (hết hàng) **không phải lỗi**: ack và phát sự kiện kết quả (`stock.reserve_failed`).
- Thư vào DLQ → log mức `error` kèm `correlationId`, phát `order.processing_failed` để sales đánh dấu đơn "cần xem xét" (chưa huỷ). Admin xem và đẩy lại thư từ DLQ sau khi sửa lỗi.
- Topology (exchange `domain.events` kiểu topic, queue `inventory.events` / `sales.events` / `report.events`, DLX, DLQ) nạp sẵn bằng `definitions.json`; queue `durable`, thư `persistent`; worker gửi với `mandatory: true`.

### 7.4 Saga cho đơn online

- Choreography qua sự kiện như mục 4.3; mỗi bước có hành động bù trừ (giữ hàng ↔ nhả hàng, nhận tiền ↔ hoàn tiền, tạo đơn ↔ huỷ đơn).
- Thư lệch thứ tự: huỷ đến trước khi giữ hàng → inventory ghi dấu `StockReservation(RELEASED, quantity 0)`; sales luôn đổi trạng thái bằng `UPDATE … WHERE status IN (…)`, nhận `stock.reserved` cho đơn đã huỷ thì phát lại `order.cancelled`.
- Sales tự theo dõi đơn: `PENDING` quá 10 phút → "cần xem xét"; quá 30 phút → huỷ và báo khách.
- Job hết hạn giữ hàng mỗi phút; đua với thanh toán được phân xử bằng `UPDATE … WHERE status = 'ACTIVE'` / `'AWAITING_PAYMENT'`.

### 7.5 Chống trùng request

- POS và website gửi `Idempotency-Key` (một mã cho mỗi giỏ hàng); `Order.idempotencyKey` unique, request lặp trả lại đơn cũ; cùng key mà `requestHash` khác → `422 IDEMPOTENCY_KEY_REUSED`.
- Sales gọi inventory (POS) bằng `orderId`: `deduct` và `release` idempotent nhờ unique `(refType, refId, variantId, type)` trên `StockMovement`; timeout 3 s, retry 1–2 lần với lỗi tạm thời, thất bại thì `release`.
- Webhook ngân hàng gửi trùng bị chặn bởi unique `BankTransaction.bankTxnRef`.

### 7.6 Hiển thị tồn trên website

- Website gọi `GET /stock/availability?variantIds=…`, trả tổng `onHand − reserved − onlineBuffer` trên các kho `acceptsOnlineOrders`. Con số được phép lệch vài giây; số chính xác được kiểm tra lại bằng UPDATE có điều kiện lúc giữ hàng.
- `onlineBuffer` theo từng kho và biến thể giữ lại hàng cho khách tại quầy.

### 7.7 Báo cáo

report-service upsert `OrderRevenue` / `OrderLineSales` theo `orderId` khi nhận `order.completed`, `order.returned` (nhận trùng vẫn đúng); doanh thu = `SUM`. Job đêm chụp `InventorySnapshot`. Có lệnh dựng lại báo cáo cho một khoảng ngày từ dữ liệu gốc của sales.

### 7.8 Đối soát mỗi đêm

- Inventory: `reserved` = tổng `StockReservation` đang `ACTIVE`; tổng `StockMovement.quantity` = `onHand`. Lệch → sửa theo bảng chi tiết, ghi `ADJUSTMENT`, log cảnh báo.
- Inventory ↔ sales: lượt giữ `ACTIVE` của đơn đã `CANCELLED` / `COMPLETED` → nhả; đơn `PENDING` / `AWAITING_PAYMENT` quá lâu không có lượt giữ → đánh dấu xem xét.
- Đêm nào cũng có chỗ lệch nghĩa là đang có bug.

**Câu hỏi còn mở**

- Có cần quản lý lô / hạn sử dụng (batch, expiry) không?
- Có tích hợp hoá đơn điện tử ngay từ đầu không?
- Chọn dịch vụ webhook biến động số dư ngân hàng nào?

## 8. Giải thích thuật ngữ

| Thuật ngữ | Nghĩa dễ hiểu | Dùng ở đâu trong hệ thống |
| --- | --- | --- |
| Service (microservice) | Một chương trình backend nhỏ lo một mảng việc, chạy riêng một container | auth, inventory, sales, report |
| Schema (PostgreSQL) | Một "ngăn" bảng riêng trong cùng một database; mỗi service chỉ đụng vào ngăn của mình | `auth`, `inventory`, `sales`, `report` |
| Khoá ngoại (foreign key) | Ràng buộc để DB tự kiểm tra id tham chiếu có tồn tại thật | Chỉ dùng trong cùng schema |
| Transaction | Gói nhiều câu lệnh: hoặc thành công hết, hoặc huỷ hết, không có nửa vời | Trừ kho + ghi sổ kho + ghi outbox |
| Đồng thời (concurrency) | Nhiều người/request cùng sửa một dữ liệu cùng lúc | 2 quầy cùng bán món hàng cuối cùng |
| Bán âm kho | Bán nhiều hơn số đang có, tồn thành số âm | Chặn bằng UPDATE có điều kiện + CHECK |
| UPDATE có điều kiện (nguyên tử) | Kiểm tra "còn đủ hàng không" và trừ trong cùng một câu lệnh, không ai chen vào giữa được | Trừ kho |
| Deadlock | Hai transaction chờ khoá của nhau mãi mãi | Tránh bằng cách luôn khoá theo thứ tự `variantId` |
| Khoá lạc quan (optimistic lock) | Mỗi bản ghi có số `version`; lúc lưu nếu version đã đổi thì báo lỗi, bắt tải lại | 2 quản lý cùng bấm duyệt phiếu nhập |
| onHand / reserved / khả dụng | Tồn thực / đang giữ cho đơn online / còn bán được = onHand − reserved | InventoryItem |
| Giữ hàng (reservation) | Khoá tạm số lượng cho một đơn chưa giao, có hạn 30 phút | Đơn online |
| Sổ kho (stock ledger) | Nhật ký mọi lần hàng vào/ra kho, chỉ thêm, không sửa | StockMovement |
| Message broker (RabbitMQ) | "Bưu điện" chuyển tin nhắn giữa các service; bên nhận đang bận hay tắt thì tin vẫn nằm chờ | Mọi sự kiện |
| Sự kiện (event) | Tin nhắn báo "việc gì vừa xảy ra", ví dụ `order.created` | Mục 1, 4.3 |
| Nhất quán cuối cùng (eventual consistency) | Dữ liệu ở các service có thể lệch nhau vài giây, rồi sẽ khớp | Báo cáo, số tồn hiển thị trên website |
| Outbox | Bảng "thư chờ gửi": ghi sự kiện cùng transaction với dữ liệu, rồi worker mới gửi lên RabbitMQ | OutboxEvent |
| Idempotent / idempotency key | Làm lại một việc nhiều lần vẫn cho kết quả như làm 1 lần; key là mã để nhận ra request lặp | Hoá đơn POS, ProcessedEvent |
| Saga | Một quy trình nhiều bước trải qua nhiều service; bước sau hỏng thì chạy bước "hoàn tác" cho bước trước | Đơn online |
| Choreography | Kiểu Saga không có "nhạc trưởng": mỗi service tự nghe sự kiện và tự biết làm gì tiếp | Đơn online |
| Hành động bù trừ (compensation) | Bước hoàn tác, ví dụ giữ hàng rồi thì nhả hàng | Huỷ đơn online |
| Retry / dead-letter queue (DLQ) | Thử lại khi xử lý lỗi; lỗi quá nhiều lần thì cất vào hàng đợi riêng để người kiểm tra | RabbitMQ |
| Ack (manual ack) | Bên nhận báo "đã xử lý xong" thì RabbitMQ mới xoá tin | Consumer |
| Webhook | Hệ thống bên ngoài chủ động gọi API của mình khi có việc mới | Ngân hàng báo có tiền vào |
| FOR UPDATE SKIP LOCKED | Lấy và khoá các dòng chưa ai khoá, bỏ qua dòng worker khác đang xử lý | Worker gửi outbox |
