# auth-service

Quản lý nhân viên, phiên đăng nhập và phát token. File này dành cho người mới đọc code: mỗi luồng gồm các bước, file và hàm chứa từng bước, bảng bị ghi, và tình huống đồng thời được xử lý thế nào. Quyết định thiết kế nằm ở `docs/thiet-ke.md` mục 2, đặc tả API ở `docs/api/auth.openapi.yaml`.

**Hai loại token:**

- **Access token:** JWT ký RS256, sống 15 phút, gửi trong header `Authorization`. Service kiểm bằng public key, không gọi DB.
- **Refresh token:** chuỗi ngẫu nhiên 32 byte, nằm trong cookie `rt_bo`, sống tối đa 30 ngày. DB chỉ giữ bản băm SHA-256, nên lộ bảng `RefreshToken` không đăng nhập được.

**Đường đi của request:** trình duyệt → nginx (backoffice) → gateway → auth. `/api/auth/x` ở gateway là `/auth/x` ở auth.

**File chính:**

| File                                                   | Nội dung                                     |
| ------------------------------------------------------ | -------------------------------------------- |
| `src/session/auth.controller.ts`                       | Cửa vào HTTP, không có logic nghiệp vụ       |
| `src/session/session.service.ts`                       | Mở phiên, refresh, đăng xuất, `me`           |
| `src/session/tokens.ts`                                | Tạo, băm refresh token, đọc và ghi cookie    |
| `src/session/access-token.service.ts`                  | Ký access token, kiểm cặp khoá lúc khởi động |
| `src/session/refresh-token-cleanup.ts`                 | Job dọn token cũ                             |
| `src/google/google-id-token.ts`                        | Kiểm ID token của Google                     |
| `src/google/google-login.service.ts`                   | Đăng nhập Google, ghép tài khoản             |
| `src/password/password.service.ts`                     | Đăng nhập mật khẩu, đổi mật khẩu             |
| `src/admin/create-admin.ts`, `src/cli/admin-create.ts` | Tạo ADMIN đầu tiên                           |

## Tạo ADMIN đầu tiên

1. Người vận hành chạy lệnh trên server, mật khẩu qua `ADMIN_PASSWORD` hoặc stdin, không qua tham số dòng lệnh: `main`, `readPassword` trong `src/cli/admin-create.ts`.
2. Kiểm email, họ tên, độ mạnh mật khẩu; băm bcrypt: `createAdmin` trong `src/admin/create-admin.ts`.
3. Tạo user cùng vai trò ADMIN và ghi nhật ký trong một transaction.

**Bảng ghi:** `User`, `UserBranch`, `AuditLog`.

**Đồng thời:** hai lệnh cùng email thì unique `User.email` chặn một bên; bắt `P2002` trên `User` và báo "Email đã tồn tại", không ghi đè.

## Đăng nhập Google

1. Giao diện nhận ID token từ Google rồi gửi `POST /api/auth/google`: `loginWithGoogle` trong `auth.controller.ts`.
2. Kiểm chữ ký bằng khoá công khai của Google, `iss`, `aud`, `exp`, `email_verified`: `verifyGoogleIdToken` trong `google-id-token.ts`. Sai → `401 INVALID_CREDENTIALS`. Không lấy được khoá của Google → `503`.
3. Lần đầu đăng nhập, ghép với user admin đã thêm trước theo email: `linkIfFirstLogin` trong `google-login.service.ts`. User phải `ACTIVE`, có vai trò, chưa liên kết Google khác.
4. Đọc lại liên kết theo `sub`, kiểm user còn hợp lệ, không đạt → `403 ACCOUNT_NOT_PROVISIONED`: `login` trong `google-login.service.ts`.
5. Mở phiên, ký access token, đặt cookie: `open` trong `session.service.ts`, `withCookie` trong `auth.controller.ts`.

**Bảng ghi:** `AuthIdentity` và `AuditLog` (chỉ lần đầu), `RefreshToken`.

**Đồng thời:** nhiều request đăng nhập đầu tiên cùng lúc. Unique `(provider, subject)` chỉ cho một bên ghép; bên thua bắt `P2002` rồi đọc lại. Request vừa tra chưa thấy liên kết nhưng ngay sau đó thấy user đã liên kết thì so `subject`: cùng `sub` là bên kia vừa ghép xong, coi như thành công.

## Đăng nhập mật khẩu ADMIN

1. `POST /api/auth/login`: `loginWithPassword` trong `auth.controller.ts`.
2. Tìm user theo email chữ thường, xác định có đủ điều kiện không: `ACTIVE`, có vai trò ADMIN, có `passwordHash`: `login` trong `password.service.ts`.
3. Luôn chạy bcrypt: user không đủ điều kiện thì so với hash giả, để thời gian phản hồi không lộ email nào tồn tại.
4. Ghi `AuditLog` cho cả thành công và thất bại (email đã nhập, IP, không ghi mật khẩu).
5. Thất bại vì bất kỳ lý do gì → cùng `401 INVALID_CREDENTIALS`. Thành công → mở phiên như Google.

**Bảng ghi:** `AuditLog`, `RefreshToken`.

**Đồng thời:** không có ghi dữ liệu dùng chung ngoài việc thêm dòng mới. Số lần thử do gateway giới hạn.

## Đổi mật khẩu

1. `POST /api/auth/change-password`, chỉ ADMIN (`@Roles('ADMIN')`): `changePassword` trong `auth.controller.ts`.
2. Kiểm mật khẩu hiện tại trước, sai → `401 INVALID_CREDENTIALS`. Rồi mới kiểm mật khẩu mới, không đạt hoặc trùng mật khẩu cũ → `400 PASSWORD_TOO_WEAK`: `change` trong `password.service.ts`.
3. Băm mật khẩu mới ngoài transaction, vì bcrypt chậm.
4. Trong một transaction: đổi mật khẩu, thu hồi mọi phiên khác (giữ phiên theo cookie đang gửi), ghi nhật ký.

**Bảng ghi:** `User`, `RefreshToken`, `AuditLog`.

Gateway giới hạn 5 lần / 15 phút theo user, xem mục Rate limit.

**Đồng thời:** hai lần đổi cùng lúc. `UPDATE` có điều kiện `passwordHash = <hash cũ>` nên chỉ một bên thắng; bên kia thấy 0 dòng và nhận `401`.

## Gọi API với access token

1. Đường cần đăng nhập: gateway tra bảng định tuyến, kiểm token và `aud` rồi mới chuyển tiếp: `forward` trong `apps/gateway/src/proxy/proxy.controller.ts`, `resolveRoute` trong `routes.ts`.
2. Service nhận request và kiểm lại, vì mọi endpoint mặc định cần đăng nhập, trừ `@Public()`: `JwtGuard` trong `libs/common/src/auth/jwt.guard.ts`. `verifyAccessToken` trong `jwt-verifier.ts` kiểm chữ ký trước, rồi `iss`, `aud`, `exp`, rồi claims bằng zod.
3. Endpoint có `@Roles(...)`: `RolesGuard` trong `roles.guard.ts` kiểm vai trò trên đúng chi nhánh của request; ADMIN luôn qua.
4. Handler lấy user bằng `@CurrentUser()`.

**Bảng ghi:** không có. Việc kiểm token không gọi DB, nên user bị khoá vẫn gọi được API tới khi access token hết hạn, tối đa 15 phút.

## Refresh

`POST /api/auth/refresh`, trong một transaction: `refresh` trong `session.service.ts`.

1. Băm cookie, `SET LOCAL lock_timeout`, rồi xoay vòng bằng `UPDATE ... WHERE "tokenHash" = ? AND "revokedAt" IS NULL RETURNING ...`.
2. **Có 1 dòng:** kiểm hạn trượt, hạn tuyệt đối, user `ACTIVE`, còn vai trò (`loadActiveUser`). Đạt thì tạo token mới giữ nguyên `sessionStartedAt` (`createToken`), rồi ký access token mới ngoài transaction.
3. **Có 0 dòng:** token không xoay vòng được, phân loại ở `handleStaleToken`.

| Tình huống                          | Kết quả                                                   | Vì sao                                                                                   |
| ----------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Hết hạn, user bị khoá, mất vai trò  | `401`, **rollback**, xoá cookie                           | Nếu commit, token có `replacedAt`, cookie cũ gửi lại sau 10 giây bị coi nhầm là đánh cắp |
| Không có token với hash đó          | `401`, xoá cookie                                         |                                                                                          |
| Bị thay trong 10 giây (hai tab)     | `409 REFRESH_CONFLICT`, giữ cookie                        | Cookie mới đã có trong trình duyệt, client gửi lại là được                               |
| Vừa đăng xuất trong 10 giây         | `401`, không thu hồi phiên khác                           | Phiên kết thúc đúng cách, không phải đánh cắp                                            |
| Thu hồi lâu hơn 10 giây bị dùng lại | Coi là đánh cắp: thu hồi mọi phiên, ghi `AuditLog`, `401` | Người thật đã có token mới, nên token cũ bị dùng là có người khác giữ                    |

**Bảng ghi:** `RefreshToken`, `AuditLog` (khi phát hiện đánh cắp).

**Đồng thời:** hai tab cùng cookie. `UPDATE` có điều kiện là trọng tài: bên sau chờ khoá dòng rồi thấy 0 dòng, đọc `replacedAt` và nhận `409`. Mọi so sánh thời gian dùng `now()` của Postgres. Lỗi hết hạn ném **trong** transaction để hoàn tác; phát hiện đánh cắp thì trả kết quả ra ngoài rồi mới ném, để việc thu hồi được commit.

## Đăng xuất

- `POST /api/auth/logout`: thu hồi token theo cookie nếu có, luôn xoá cookie, luôn `204`: `logout` trong `session.service.ts`.
- `POST /api/auth/logout-all`: cần access token, thu hồi mọi phiên của user: `logoutAll`.

**Bảng ghi:** `RefreshToken`.

**Đồng thời:** `updateMany` với điều kiện `revokedAt = null`, gọi trùng không có tác dụng phụ. Access token đang dùng vẫn hiệu lực tới khi hết hạn.

## `GET /api/auth/me`

Cần access token. Đọc user, vai trò và trạng thái liên kết Google từ DB: `currentUser` trong `session.service.ts`. Vai trò ở đây là mới nhất, có thể khác vai trò trong token. Chỉ đọc, không có tình huống đồng thời.

## Dọn token

Job chạy mỗi giờ: `RefreshTokenCleanupJob` trong `src/session/refresh-token-cleanup.ts`. `deleteStaleRefreshTokens` xoá token đã thu hồi hoặc đã hết hạn quá 30 ngày; token còn hiệu lực không khớp cả hai điều kiện.

**Bảng ghi:** `RefreshToken`.

**Đồng thời:** nhiều instance cùng chạy không sao, câu `DELETE` lặp lại không có tác dụng phụ.

## Rate limit và IP thật

Hai việc này ở gateway, auth chỉ đọc kết quả.

**IP thật:**

1. nginx thêm địa chỉ kết nối vào cuối `X-Forwarded-For`.
2. Gateway chỉ tin header này khi kết nối đến từ `TRUSTED_PROXIES`, đọc từ phải sang trái, lấy địa chỉ đầu tiên không phải proxy tin cậy: `resolveClientIp` trong `apps/gateway/src/proxy/client-ip.ts`. Phần client tự viết nằm ở đầu chuỗi nên bị bỏ qua.
3. Gateway đặt lại `x-forwarded-for` khi chuyển tiếp: `forwardRequestHeaders` trong `headers.ts`. Auth đọc ở `clientInfo` trong `auth.controller.ts`, ghi vào `RefreshToken.ip` và `AuditLog`.

**Rate limit:**

1. Sau khi đọc body, gateway gọi `RateLimitService.enforce` trong `rate-limit.service.ts`, trước khi chuyển tiếp.
2. `rateLimitsFor` trong `rate-limit-rules.ts` chọn giới hạn theo đường đã chuẩn hoá, để `/auth/LOGIN/` không lách được. Riêng đổi mật khẩu giới hạn theo user, nên gateway kiểm access token trước khi đếm (`isLimitedByUser`), để không ai tự khai `sub` của người khác.
3. Vượt → `429 RATE_LIMITED` có `Retry-After`, request không tới auth.

| Đường                            | Giới hạn                                            |
| -------------------------------- | --------------------------------------------------- |
| `POST /api/auth/login`           | 5 lần / phút theo IP + email, 20 lần / phút theo IP |
| `POST /api/auth/google`          | 20 lần / phút theo IP                               |
| `POST /api/auth/refresh`         | 60 lần / phút theo IP                               |
| `POST /api/auth/change-password` | 5 lần / 15 phút theo user, 20 lần / phút theo IP    |

**Bảng ghi:** không có, bộ đếm nằm trong bộ nhớ gateway.

**Đồng thời:** bộ đếm của `@nestjs/throttler` chỉ đúng khi chạy một instance gateway. Từ 2 instance trở lên phải chuyển sang bộ đếm dùng chung (Redis).
