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
| auth-service | Chi nhánh, nhân viên, vai trò, tài khoản khách, đăng nhập, cấp token | `branch.created`, `branch.updated` | — |
| inventory-service | Sản phẩm, biến thể, giá, kho, tồn kho, nhập hàng, kiểm kê, giữ hàng cho đơn online, chọn chi nhánh xuất đơn online | `stock.reserved`, `stock.reserve_failed`, `stock.reservation_expired`, `stock.changed`, `order.processing_failed`, `product.snapshot`, `stock.availability_changed` | `branch.created`, `branch.updated`, `order.created`, `order.cancelled`, `order.paid`, `order.shipping` |
| sales-service | Hoá đơn POS, đơn online, khách hàng, bản sao danh mục cho website, thanh toán chuyển khoản, hoàn tiền, trả hàng | `order.created`, `order.cancelled`, `order.paid`, `order.shipping`, `order.completed`, `order.returned` | `stock.*`, `product.snapshot`, `order.processing_failed` |
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

**API quản trị của auth** (`/api/admin/auth/*`, đặc tả ở `docs/api/auth.openapi.yaml`) dùng một hàm chính sách thay cho `@Roles`, vì `/users/{userId}` không có `branchId` trong request, chỉ biết chi nhánh sau khi đọc user:

- ADMIN: mọi thao tác. Không ai được tự khoá chính mình hay tự đặt lại mật khẩu (tự đổi dùng `change-password`).
- MANAGER: xem danh sách đúng chi nhánh mình quản lý (`branchId` bắt buộc); tạo user chỉ vai trò STAFF ở chi nhánh mình; xem, sửa, khoá, mở khoá, gỡ Google chỉ khi user đó **chỉ có vai trò STAFF** và **mọi** chi nhánh của user đều do MANAGER này quản lý. Không gán vai trò, không đặt lại mật khẩu.
- Vi phạm → `403 FORBIDDEN`.
- Quyền đọc từ DB, không từ token: token sống tối đa 15 phút sau khi bị khoá hoặc hạ vai trò, nếu tin token thì ADMIN vừa bị khoá tự mở khoá được.
- Vai trò ở chi nhánh đã ngừng hoạt động vẫn còn trong `UserBranch` nhưng không vào token, không có hiệu lực khi kiểm quyền.

**ADMIN cuối cùng:** hệ thống phải luôn còn ít nhất một ADMIN đang hoạt động (`ACTIVE`, có vai trò ADMIN, có mật khẩu hoặc Google). Khoá ADMIN, bỏ vai trò ADMIN, gỡ Google của ADMIN không có mật khẩu chạy trong transaction: `SELECT ... FOR UPDATE` các dòng `User` của mọi ADMIN đang hoạt động và user bị thao tác (sắp theo id) **trước** khi đổi, rồi đếm lại **sau** khi đổi; bằng 0 → rollback, `409 LAST_ADMIN`.

**Thứ tự khoá khi thu hồi phiên:** luôn là dòng `User` rồi mới tới `RefreshToken`. Thao tác quản trị giữ `FOR UPDATE`; đăng nhập và refresh giữ `FOR SHARE` trên user trước khi đọc trạng thái hoặc đụng vào token. Nhờ vậy phiên mở đúng lúc khoá user không sót lại, và refresh không deadlock với thao tác quản trị.

### Xác thực (token)

|  | Access token | Refresh token |
| --- | --- | --- |
| Dạng | JWT ký RS256, có `jti` | Chuỗi ngẫu nhiên 32 byte, không phải JWT |
| Nội dung | `sub` (userId hoặc id tài khoản khách), `branches[{branchId, role}]` (rỗng với khách), `iss`, `aud`, `iat`, `exp` | Không chứa gì |
| Hạn | 15 phút | Hạn trượt 7 ngày (gia hạn mỗi lần refresh), hạn tuyệt đối 30 ngày tính từ `sessionStartedAt` |
| Client lưu | Biến trong bộ nhớ React | Cookie `httpOnly; Secure; SameSite=Strict`: nhân viên `rt_bo`, `Path=/api/auth`; khách `rt_shop`, `Path=/api/shop/auth` (giai đoạn 6) |
| Server lưu | Không lưu | Bản băm SHA-256 trong `auth.RefreshToken` |
| Ai kiểm tra | Gateway và mọi service, bằng public key, không gọi DB | Chỉ auth-service, tra DB |

**Khoá:** hệ thống dùng một cặp khoá RSA 2048, sinh bằng `pnpm keys:generate`. Private key ở `secrets/jwt/private.pem`: chỉ auth-service được mount (`JWT_PRIVATE_KEY_PATH`). Public key ở `secrets/jwt/public.pem`: gateway và mọi service mount read-only (`JWT_PUBLIC_KEY_PATH`). Khoá thiếu, nhầm private key với public key, hoặc RSA dưới 2048 bit → service không bật; auth còn kiểm private và public là một cặp. Đổi khoá = tạo cặp mới, thay ở mọi service cùng lúc: mọi access token cũ hết hiệu lực nên **mọi người phải đăng nhập lại**. Chấp nhận điều này vì đổi khoá hiếm, đổi lấy cấu hình đơn giản.

**Kiểm tra access token (gateway + mọi service):** dùng thư viện `jose`, ép `algorithms: ['RS256']`, kiểm tra chữ ký bằng đúng một public key trước, rồi `exp` (bắt buộc, lệch tối đa 30 giây), `nbf`, `iss`, `aud` (`JWT_ISSUER = auth-service`; `aud` theo loại token, xem dưới), rồi claims `sub`, `branches` bằng zod (`accessTokenClaimsSchema`). Hết hạn → `401 TOKEN_EXPIRED`; sai → `401 INVALID_TOKEN`. Gateway xoá mọi header `x-user-*` từ client và chuyển nguyên `Authorization` xuống service; service kiểm tra lại token (lớp bảo vệ thứ hai). Mọi endpoint mặc định cần đăng nhập, ngoại lệ đánh dấu `@Public()`.

**Hai loại token:** cùng `iss`, khác `aud`: `store-backoffice` (`JWT_AUDIENCE_BACKOFFICE`, nhân viên) và `store-shop` (`JWT_AUDIENCE_SHOP`, khách). Gateway và service kiểm `aud` theo đường dẫn, nên token của khách không dùng được ở đường của nhân viên và ngược lại. `JwtGuard` mặc định yêu cầu `aud` nhân viên; endpoint của khách đánh dấu `@Audience('shop')`. Sai `aud` → `401 INVALID_TOKEN`.

**Định tuyến ở gateway** (`apps/gateway/src/proxy/routes.ts`):

| Đường ở gateway | Service | Đường ở service | Gateway kiểm token | `aud` yêu cầu |
| --- | --- | --- | --- | --- |
| `/api/auth/*` | auth | `/auth/*` | Không (login, google, refresh, logout) | Công khai ở gateway; `me`, `change-password`, `logout-all` do auth kiểm, `aud` nhân viên |
| `/api/pos/*` | sales | `/pos/*` | Có | nhân viên |
| `/api/online-orders/*` | sales | `/online-orders/*` | Có | nhân viên |
| `/api/shop/auth/*` | auth | `/shop/auth/*` | Không (giai đoạn 6) | Công khai ở gateway; endpoint cần đăng nhập do auth kiểm, `aud` khách |
| `/api/shop/*` | sales | `/shop/*` | Không (website khách) | Công khai ở gateway; endpoint của khách do sales kiểm, `aud` khách |
| `/api/admin/auth/*` | auth | `/admin/*` | Có | nhân viên |
| `/api/admin/inventory/*` | inventory | `/admin/*` | Có | nhân viên |
| `/api/admin/sales/*` | sales | `/admin/*` | Có | nhân viên |
| `/api/admin/reports/*` | report | `/admin/*` | Có | nhân viên |
| `/webhooks/bank` | sales | `/webhooks/bank` | Không (kiểm chữ ký ở giai đoạn 6) | — |

Đường không có trong bảng → `404 NOT_FOUND`. `/internal/*` và `/health/*` của service không bao giờ được gateway chuyển tiếp. Đường cần đăng nhập: gateway kiểm tra token trước, sai thì trả lỗi luôn, không chuyển tiếp.

Các đường API nêu trong tài liệu này là đường ở gateway, chỉ để minh hoạ luồng. Danh sách endpoint đầy đủ nằm trong OpenAPI ở `docs/api/`: đã có `auth.openapi.yaml`, các service khác đang soạn.

**Refresh:** trong một transaction, băm cookie rồi xoay vòng bằng UPDATE có điều kiện (`SET revokedAt, replacedAt WHERE tokenHash = ? AND revokedAt IS NULL RETURNING ...`):

- **1 dòng:** kiểm tra hạn trượt, hạn tuyệt đối, user `ACTIVE`, còn vai trò; tạo token mới giữ nguyên `sessionStartedAt`; đọc lại vai trò mới nhất. Không đạt thì **rollback** rồi trả `401 SESSION_EXPIRED`, để cookie hết hạn gửi lại không bị coi nhầm là đánh cắp.
- **0 dòng, không có token:** `401 SESSION_EXPIRED`.
- **0 dòng, token bị thay trong 10 giây gần đây (`replacedAt`):** `409 REFRESH_CONFLICT`. Đây là hai tab refresh cùng lúc; client gửi lại là được, không thu hồi phiên.
- **0 dòng, token vừa bị thu hồi trong 10 giây mà không phải do xoay vòng:** tab khác vừa đăng xuất; `401 SESSION_EXPIRED`, không thu hồi phiên khác.
- **0 dòng, token đã thu hồi lâu hơn thế:** coi là bị đánh cắp: thu hồi mọi refresh token của user, ghi `AuditLog`, `401 SESSION_EXPIRED`.

Mọi so sánh thời gian dùng `now()` của Postgres. Trả `401 SESSION_EXPIRED` thì xoá cookie; `409` thì không, vì cookie mới là của tab thắng.

**Frontend:** interceptor axios bắt `TOKEN_EXPIRED`, chỉ chạy một lần refresh tại một thời điểm (các request khác chờ chung), rồi gửi lại request; refresh hỏng → về màn đăng nhập, lưu tạm giỏ hàng POS. Refresh chủ động khoảng 1 phút trước `exp`.

**Tài khoản:** auth giữ `User` (nhân viên) và `CustomerAccount` (khách, giai đoạn 6). Sales có `Customer.accountId`. Không gộp đơn cũ theo số điện thoại.

**Cách đăng nhập của nhân viên:**

- **MANAGER, STAFF: chỉ Google.** Không có mật khẩu.
- **ADMIN: Google hoặc mật khẩu.** Mật khẩu là đường vào dự phòng khi Google lỗi; tối thiểu 12 ký tự, bcrypt.
- Đăng nhập bằng mật khẩu chỉ thành công với user đang có vai trò ADMIN. Mọi trường hợp khác (sai email, sai mật khẩu, không phải ADMIN, bị khoá) trả **cùng** `401 INVALID_CREDENTIALS`.
- Mọi trường hợp thất bại tốn cùng thời gian: không có user phù hợp vẫn chạy một lần bcrypt với hash giả, để không dò được email nào tồn tại. Ghi `AuditLog` cho cả lần thành công và thất bại (email đã nhập, IP; không ghi mật khẩu).
- Đổi mật khẩu (chỉ ADMIN): kiểm mật khẩu hiện tại, mật khẩu mới phải khác mật khẩu cũ; đổi + thu hồi mọi phiên khác + `AuditLog` trong một transaction, giữ phiên đang dùng.

**Rate limit ở gateway** (thư viện @nestjs/throttler, đếm trong bộ nhớ, chỉ đúng với 1 instance gateway; từ 2 instance phải chuyển sang bộ đếm dùng chung bằng Redis):

| Đường | Giới hạn |
| --- | --- |
| `POST /api/auth/login` | 5 lần / phút theo IP + email, và 20 lần / phút theo IP |
| `POST /api/auth/google` | 20 lần / phút theo IP |
| `POST /api/auth/refresh` | 60 lần / phút theo IP |
| `POST /api/auth/change-password` | 5 lần / 15 phút theo user, 20 lần / phút theo IP |

Vượt → `429 RATE_LIMITED`, có header `Retry-After`.

**IP thật của người dùng:** nginx của backoffice và storefront thêm địa chỉ kết nối vào cuối `X-Forwarded-For`. Gateway chỉ tin header này khi kết nối tới từ địa chỉ trong `TRUSTED_PROXIES`, đọc từ phải sang trái và lấy địa chỉ đầu tiên không phải proxy tin cậy; ngược lại dùng địa chỉ kết nối. Mặc định chỉ tin hai nginx (IP tĩnh trong mạng Compose), không tin cả mạng, vì kết nối từ ngoài qua cổng đã mở của gateway có thể mang địa chỉ bridge trong mạng đó. Gateway đặt lại `x-forwarded-for` khi chuyển tiếp, auth đọc từ đó để ghi `RefreshToken.ip` và `AuditLog`.

**Dọn `RefreshToken`:** job chạy mỗi giờ trong auth, xoá token đã thu hồi hoặc đã hết hạn quá 30 ngày.
- ADMIN đầu tiên tạo bằng lệnh CLI chạy trên server: email và mật khẩu lấy từ biến môi trường hoặc stdin, không qua tham số dòng lệnh. ADMIN mới do ADMIN khác tạo, bắt buộc đặt mật khẩu.
- Hạ vai trò khỏi ADMIN → xoá `passwordHash`, thu hồi mọi phiên. Nâng lên ADMIN → bắt buộc đặt mật khẩu trong cùng thao tác.
- Rủi ro chấp nhận: Google lỗi thì chỉ ADMIN đăng nhập được.

**Đăng nhập Google (cách A):** Google Identity Services trả ID token cho trình duyệt; trình duyệt gửi `credential` cho auth; auth kiểm bằng `jose` + JWKS của Google: `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`}, `aud = GOOGLE_CLIENT_ID`, `exp`, `email_verified = true`. Ghép theo `sub` qua bảng `AuthIdentity(provider, subject)`. Nhân viên chỉ ghép được với email admin đã thêm trước, không tự đăng ký; user phải `ACTIVE`, có vai trò, chưa liên kết Google. Lần đầu ghép → ghi `AuditLog`. Hai lần đăng nhập đầu tiên song song: unique constraint làm trọng tài, bên thua đọc lại identity vừa tạo. Không lấy được khoá của Google → `503 SERVICE_UNAVAILABLE`.

**Rủi ro Gmail cá nhân:** hệ thống không ép được xác minh 2 bước trên tài khoản Gmail cá nhân. Khuyến nghị mọi nhân viên bật xác minh 2 bước. Khi có dấu hiệu lạ: quản lý khoá tài khoản (`lock`) hoặc gỡ liên kết (`unlink-google`), cả hai đều thu hồi mọi phiên; nhân viên kiểm tra lại tài khoản Google rồi mới mở khoá và liên kết lại.

**Khoá tài khoản:** `status = LOCKED` + thu hồi mọi refresh token; access token đang dùng hết hiệu lực trong tối đa 15 phút.

## 3. Chức năng chi tiết theo module

Tổng cộng 8 module; mỗi module dưới đây liệt kê chức năng cho phiên bản đầu (MVP) và service sở hữu.

### 3.1 Chi nhánh (auth-service)

- CRUD chi nhánh: mã, tên, địa chỉ, SĐT, trạng thái hoạt động.
- Mỗi chi nhánh có đúng 1 kho (inventory tự tạo khi nhận `branch.created`); bật/tắt việc chi nhánh nhận đơn online.
- Gán quản lý chi nhánh.

### 3.2 Nhân viên & phân quyền (auth-service)

- Đăng nhập Google (mọi nhân viên) hoặc mật khẩu (chỉ ADMIN), JWT access 15 phút + refresh token 7 ngày, đăng xuất thu hồi refresh token.
- CRUD nhân viên, khoá/mở tài khoản, gỡ liên kết Google, đổi mật khẩu (chỉ ADMIN).
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

- Website hiển thị danh mục, giá tạm tính và số còn bán được từ bản sao chỉ đọc trong sales (mục 7.6). Số còn bán được = tổng `onHand − reserved − onlineBuffer` của mọi chi nhánh nhận đơn online, chỉ để tham khảo.
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

1. Thu ngân quét hàng, POS gọi `POST /api/pos/orders` kèm header `Idempotency-Key` (mã chống gửi trùng, xem mục 7).
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

1. **Tạo đơn (sales):** website gọi `POST /api/shop/orders` (có `Idempotency-Key`). Một transaction: tạo `Order(PENDING, warehouseId = null)` + outbox `order.created { orderId, items }`. Website hiện "Đang kiểm tra hàng…" và hỏi lại trạng thái mỗi 1–2 giây.
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
                             User 1 ──< AuthIdentity
AuditLog (→ User)
CustomerAccount (giai đoạn 6)
```

| Bảng | Cột chính | Ghi chú |
| --- | --- | --- |
| Branch | code (unique), name, address, phone, isActive, version | Chi nhánh |
| User | email (unique, luôn chữ thường, có CHECK), passwordHash (null trừ ADMIN), fullName, phone, status (`ACTIVE`, `LOCKED`), version | Nhân viên |
| UserBranch | userId, branchId (null = toàn hệ thống), role (`ADMIN`, `MANAGER`, `STAFF`) | Unique (userId, branchId) |
| RefreshToken | userId, tokenHash (unique), expiresAt (hạn trượt), sessionStartedAt (hạn tuyệt đối), revokedAt, replacedAt (có giá trị khi bị xoay vòng), userAgent, ip | Phiên đăng nhập |
| AuthIdentity | userId, provider (`GOOGLE`), subject (`sub` của nhà cung cấp) | Unique (provider, subject); một user tối đa một liên kết mỗi provider |
| AuditLog | actorId, action, entityType, entityId, data (JSONB), correlationId | Chỉ ghi thêm. Ghi khi ghép Google lần đầu, gỡ liên kết, khoá/mở, đổi vai trò, đặt lại mật khẩu |

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
| Customer | phone (unique), name, email, address, totalSpent, accountId (null, → auth.CustomerAccount) | Không gộp đơn cũ theo số điện thoại |
| CatalogProduct | productId (PK, → inventory.Product), name, slug, description, imageUrl, isActive, version | Bản sao chỉ đọc, chỉ dữ liệu công khai (mục 7.6) |
| CatalogVariant | variantId (PK, → inventory.ProductVariant), productId, sku, size, estimatedPrice, version | Giá tạm tính do inventory tính, chép lại |
| CatalogAvailability | variantId (PK), available, version | Số còn bán được online, chỉ để tham khảo |
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
| OutboxEvent | aggregateType, aggregateId, eventType, payload (JSONB), correlationId, status, attempts, lockedUntil, nextAttemptAt, publishedAt | Ghi cùng transaction nghiệp vụ |
| ProcessedEvent | eventId + consumer (khoá chính), processedAt | Chống xử lý trùng |

## 6. Prisma schema (service lõi)

Schema đầy đủ cho auth, inventory và sales; report viết theo bảng ở mục 5.4. Mỗi service có `OutboxEvent` và `ProcessedEvent` như ở 6.2 (auth chỉ cần `OutboxEvent`). Các CHECK constraint thêm bằng migration SQL viết tay.

### 6.1 auth-service

```prisma
enum UserStatus { ACTIVE LOCKED }
enum Role { ADMIN MANAGER STAFF }
enum AuthProvider { GOOGLE }

model Branch {
  id        String       @id @default(uuid()) @db.Uuid
  code      String       @unique
  name      String
  address   String?
  phone     String?
  isActive  Boolean      @default(true)
  version   Int          @default(1)
  members   UserBranch[]
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt
}

model User {
  id           String         @id @default(uuid()) @db.Uuid
  email        String         @unique
  passwordHash String?        // chỉ ADMIN có giá trị
  fullName     String
  phone        String?
  status       UserStatus     @default(ACTIVE)
  version      Int            @default(1)
  branches     UserBranch[]
  tokens       RefreshToken[]
  identities   AuthIdentity[]
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
  replacedAt       DateTime? // có giá trị khi bị xoay vòng, phân biệt với đăng xuất
  userAgent        String?
  ip               String?
  user             User      @relation(fields: [userId], references: [id])
  createdAt        DateTime  @default(now())
  @@index([userId])
}

model AuthIdentity {
  id        String       @id @default(uuid()) @db.Uuid
  userId    String       @db.Uuid
  provider  AuthProvider
  subject   String       // `sub` của nhà cung cấp, không dùng email để ghép
  user      User         @relation(fields: [userId], references: [id])
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt
  @@unique([provider, subject])
  @@unique([provider, userId])
}

model AuditLog { // chỉ ghi thêm
  id            String   @id @default(uuid()) @db.Uuid
  actorId       String?  @db.Uuid // null = lệnh CLI trên server
  action        String
  entityType    String
  entityId      String   @db.Uuid
  data          Json
  correlationId String
  createdAt     DateTime @default(now())
  @@index([entityType, entityId])
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
enum OutboxStatus { PENDING PROCESSING PUBLISHED FAILED }

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
  id            String       @id @db.Uuid // = eventId, do outbox.add sinh
  eventType     String
  aggregateType String
  aggregateId   String       @db.Uuid
  payload       Json
  correlationId String
  status        OutboxStatus @default(PENDING)
  attempts      Int          @default(0)
  lockedUntil   DateTime?    @db.Timestamptz(3)
  nextAttemptAt DateTime?    @db.Timestamptz(3)
  createdAt     DateTime     @default(now()) @db.Timestamptz(3)
  updatedAt     DateTime     @default(now()) @updatedAt @db.Timestamptz(3)
  publishedAt   DateTime?    @db.Timestamptz(3)
  @@index([status, createdAt])
}

model ProcessedEvent {
  eventId     String   @db.Uuid
  consumer    String
  processedAt DateTime @default(now()) @db.Timestamptz(3)
  @@id([eventId, consumer]) // một thư có thể tới nhiều consumer
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

1. Service ghi dữ liệu nghiệp vụ và `OutboxEvent(PENDING)` trong cùng một transaction, bằng `outbox.add(tx, ...)` (kiểm tra payload theo schema trong `libs/contracts`, kèm correlationId hiện tại).
2. Worker chạy mỗi 500 ms. **Nhận lô:** một transaction ngắn chọn tối đa 100 dòng `PENDING` đã tới `nextAttemptAt` (hoặc chưa có) hoặc `PROCESSING` đã quá `lockedUntil` bằng `FOR UPDATE SKIP LOCKED`, đặt `PROCESSING`, `lockedUntil = now + 30 s`, rồi commit.
3. **Gửi** từng thư lên exchange `domain.events`, ngoài transaction: `persistent`, `mandatory`, `messageId = eventId`, header `x-correlation-id`, chờ publisher confirm. Thành công → `PUBLISHED`.
4. Lỗi của thư (bị trả lại vì không queue nào nhận, nack) → về `PENDING`, `attempts + 1`, `nextAttemptAt = now + min(2^attempts giây, 5 phút)`; đủ 10 lần → `FAILED`, log lỗi. Sửa xong nguyên nhân thì gửi lại bằng `outbox:requeue` (xem README). Thư bị trả lại vẫn được broker ack, nên phải bắt sự kiện `return`, không chỉ chờ confirm.
5. Mất kết nối không phải lỗi của thư, không tăng `attempts`: đang mất kết nối thì không nhận lô; đứt giữa lô thì trả phần còn lại về `PENDING`. Nếu không, chỉ 5 giây mất RabbitMQ là mọi dòng thành `FAILED`.
6. Worker chỉ gửi trong 25 giây đầu của thời gian giữ dòng; phần chưa gửi về `PENDING`. 5 giây còn lại dành cho thư cuối chờ confirm, để dòng không hết hạn khi thư đang gửi.
7. Job dọn xoá dòng `PUBLISHED` cũ hơn 7 ngày.

```
                 nhận lô                 confirm ok
    PENDING ───────────────► PROCESSING ───────────► PUBLISHED ──(7 ngày)──► xoá
       ▲                        │  │  │
       │  lỗi thư, attempts + 1 │  │  │ đủ 10 lần
       ├────────────────────────┘  │  └───────────► FAILED
       │  mất kết nối / gần hết giờ│
       └───────────────────────────┘
    PROCESSING quá lockedUntil (worker chết) → được nhận lại như PENDING
```

Đảm bảo là **at-least-once**: không có trường hợp DB đã commit mà sự kiện bị mất, hoặc sự kiện đã gửi mà DB rollback; worker chết sau khi gửi mà trước khi ghi `PUBLISHED` thì thư được gửi lại, và consumer chống trùng ở 7.3.

### 7.3 Consumer idempotent, retry và DLQ

- Mỗi thư có phong bì `{ eventId, eventType, occurredAt, correlationId, payload }`; `eventId` = id dòng outbox. Consumer kiểm tra phong bì và payload bằng zod, đặt correlationId vào CLS.
- Trong **một transaction**: ghi `ProcessedEvent(eventId, consumer)` trước, rồi gọi handler với `tx`. Trùng đúng khoá chính `ProcessedEvent` (`P2002` với `constraint.index = ProcessedEvent_pkey`; Prisma 7 không còn `meta.target`) → đã xử lý, ack. `P2002` ở bảng khác là lỗi thật. Lớp thứ hai chống trùng *việc*: unique theo `orderId` (`StockReservation`, `StockMovement`, `OrderRevenue`).
- Manual ack sau khi commit; `prefetch = 10`; service có consumer phải có `DATABASE_POOL_MAX >= prefetch + 5` (chừa cho worker outbox và request HTTP), không đạt thì không bật. Consumer chỉ subscribe queue có sẵn, không khai báo topology; user ứng dụng không có quyền `configure`.
- Lỗi tạm thời (mất kết nối DB, timeout, `40P01`, `40001`, `TransientError`) → consumer gửi **bản sao** vào queue chờ `<queue>.retry.5s` / `.retry.30s` / `.retry.5m` kèm header đếm `x-retry-count`, chờ confirm, **rồi** mới ack thư gốc. Queue chờ có TTL, không có consumer, hết hạn thì thư quay lại queue chính. Quá 3 lần → DLQ. Gửi bản sao lỗi → trả thư gốc về queue, không mất thư.
- Lỗi vĩnh viễn (sai schema, không có handler, `PermanentError`, mọi lỗi không nhận ra) → DLQ ngay. Lỗi nghiệp vụ (hết hàng) **không phải lỗi**: handler không ném, tự ghi outbox sự kiện kết quả (`stock.reserve_failed`), rồi ack.
- Thư vào DLQ bằng bản sao: giữ nguyên nội dung, thêm header `x-error-kind`, `x-error-reason`, `x-failed-queue`, `x-correlation-id`. Dùng bản sao thay cho nack vì nack không mang được lý do lỗi. Log mức `error` kèm `correlationId`, phát `order.processing_failed` để sales đánh dấu đơn "cần xem xét" (chưa huỷ). Admin xem và đẩy lại thư từ DLQ sau khi sửa lỗi.
- Luồng retry:

```
domain.events ─► <queue> ─► consumer ──ok──► commit, ack
                    ▲          │
                    │          ├─ tạm thời, chưa quá 3 lần ─► <queue>.retry.{5s,30s,5m} ─(hết TTL)─┐
                    └──────────┼────────────────────────────────────────────────────────────────┘
                               └─ vĩnh viễn, hoặc đã thử 3 lần ─► <queue>.dlq
```

- Topology (exchange `domain.events` kiểu topic, queue `inventory.events` / `sales.events` / `report.events`, queue chờ, DLX, DLQ) nạp sẵn bằng `definitions.json`; queue `durable`, thư `persistent`; worker gửi với `mandatory: true`. Sự kiện `system.test` bind vào `report.events` chỉ để kiểm thử đường đi outbox → consumer.

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

- Website lấy danh mục, giá và số tồn từ **bản sao chỉ đọc trong sales**: `CatalogProduct`, `CatalogVariant`, `CatalogAvailability`, chỉ chứa dữ liệu công khai, đọc qua `/api/shop/*`. Website không gọi inventory, và không thêm HTTP nội bộ ngoài luồng POS. Làm ở giai đoạn 6.
- Inventory phát `product.snapshot` (toàn bộ dữ liệu công khai của một mẫu, kèm giá tạm tính và `version` tăng dần) và `stock.availability_changed` (`variantId`, tổng còn bán được online = `onHand − reserved − onlineBuffer` trên các kho `acceptsOnlineOrders`, `version`).
- Sales chỉ ghi đè khi `version` mới hơn bản đang có, nên thư trùng hay lệch thứ tự vẫn đúng.
- Khi giá kim loại đổi, inventory tự tính lại và phát snapshot cho các mẫu bị ảnh hưởng. Công thức giá **chỉ** ở inventory; sales chỉ chép lại kết quả.
- Có lệnh phát lại toàn bộ snapshot, dùng khi dựng lại bản sao.
- Số tồn trên web chỉ để tham khảo: lúc giữ hàng inventory vẫn kiểm tra lại bằng UPDATE có điều kiện và chốt giá theo chiếc.
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
