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
| `src/admin/policy.ts`                                  | Chính sách quyền của API quản trị            |
| `src/admin/last-admin.ts`                              | Quy tắc ADMIN cuối cùng                      |
| `src/admin/branches.service.ts`                        | Quản lý chi nhánh                            |
| `src/admin/users.service.ts`                           | Quản lý nhân viên                            |
| `src/admin/audit.ts`                                   | Ghi `AuditLog` có `before`, `after`          |
| `src/session/active-assignments.ts`                    | Vai trò còn hiệu lực                         |

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
5. Mở phiên, ký access token, đặt cookie: `open` trong `session.service.ts`, `withCookie` trong `auth.controller.ts`. `open` giữ `FOR SHARE` trên user rồi đọc lại trạng thái và vai trò, không còn hợp lệ thì trả cùng lỗi `403`.

**Bảng ghi:** `AuthIdentity` và `AuditLog` (chỉ lần đầu), `RefreshToken`.

**Đồng thời:** user bị khoá đúng lúc đăng nhập: `FOR SHARE` trong `open` khiến request hoặc thấy `LOCKED`, hoặc khoá phải chờ phiên này commit rồi thu hồi luôn. Nhiều request đăng nhập đầu tiên cùng lúc: unique `(provider, subject)` chỉ cho một bên ghép; bên thua bắt `P2002` rồi đọc lại. Request vừa tra chưa thấy liên kết nhưng ngay sau đó thấy user đã liên kết thì so `subject`: cùng `sub` là bên kia vừa ghép xong, coi như thành công.

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

1. Băm cookie, `SET LOCAL lock_timeout`, giữ `FOR SHARE` trên user của token, rồi xoay vòng bằng `UPDATE ... WHERE "tokenHash" = ? AND "revokedAt" IS NULL RETURNING ...`.
2. **Có 1 dòng:** kiểm hạn trượt, hạn tuyệt đối, user `ACTIVE`, còn vai trò hiệu lực (`loadActiveUser`, vai trò ở chi nhánh đã ngừng hoạt động không vào token). Đạt thì tạo token mới giữ nguyên `sessionStartedAt` (`createToken`), rồi ký access token mới ngoài transaction.
3. **Có 0 dòng:** token không xoay vòng được, phân loại ở `handleStaleToken`.

| Tình huống                          | Kết quả                                                   | Vì sao                                                                                   |
| ----------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Hết hạn, user bị khoá, mất vai trò  | `401`, **rollback**, xoá cookie                           | Nếu commit, token có `replacedAt`, cookie cũ gửi lại sau 10 giây bị coi nhầm là đánh cắp |
| Không có token với hash đó          | `401`, xoá cookie                                         |                                                                                          |
| Bị thay trong 10 giây (hai tab)     | `409 REFRESH_CONFLICT`, giữ cookie                        | Cookie mới đã có trong trình duyệt, client gửi lại là được                               |
| Vừa đăng xuất trong 10 giây         | `401`, không thu hồi phiên khác                           | Phiên kết thúc đúng cách, không phải đánh cắp                                            |
| Thu hồi lâu hơn 10 giây bị dùng lại | Coi là đánh cắp: thu hồi mọi phiên, ghi `AuditLog`, `401` | Người thật đã có token mới, nên token cũ bị dùng là có người khác giữ                    |

**Bảng ghi:** `RefreshToken`, `AuditLog` (khi phát hiện đánh cắp).

**Đồng thời:** thứ tự khoá luôn là user rồi tới token, giống thao tác quản trị, nên không deadlock; admin khoá user xong thì token đã thu hồi, refresh nhận `401`. Hai tab cùng cookie: `UPDATE` có điều kiện là trọng tài: bên sau chờ khoá dòng rồi thấy 0 dòng, đọc `replacedAt` và nhận `409`. Mọi so sánh thời gian dùng `now()` của Postgres. Lỗi hết hạn ném **trong** transaction để hoàn tác; phát hiện đánh cắp thì trả kết quả ra ngoài rồi mới ném, để việc thu hồi được commit.

## Đăng xuất

- `POST /api/auth/logout`: thu hồi token theo cookie nếu có, luôn xoá cookie, luôn `204`: `logout` trong `session.service.ts`.
- `POST /api/auth/logout-all`: cần access token, thu hồi mọi phiên của user: `logoutAll`.

**Bảng ghi:** `RefreshToken`.

**Đồng thời:** `updateMany` với điều kiện `revokedAt = null`, gọi trùng không có tác dụng phụ. Access token đang dùng vẫn hiệu lực tới khi hết hạn.

## `GET /api/auth/me`

Cần access token. Đọc user, vai trò và trạng thái liên kết Google từ DB: `currentUser` trong `session.service.ts`. Vai trò ở đây là mới nhất, có thể khác vai trò trong token. Chỉ đọc, không có tình huống đồng thời.

## Chính sách quyền

Mọi quyết định nằm ở một hàm: `isAllowed` trong `src/admin/policy.ts`. `assertAllowed` ném `403 FORBIDDEN` khi không đạt. Không dùng `@Roles`, vì `RolesGuard` đòi `branchId` trong request còn `/users/{userId}` chỉ biết chi nhánh sau khi đọc user.

| Người thao tác | Được làm                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADMIN          | Mọi thao tác, trừ tự khoá chính mình                                                                                                                                                             |
| MANAGER        | Danh sách user đúng chi nhánh mình quản lý (`branchId` bắt buộc); tạo user chỉ vai trò STAFF ở chi nhánh mình; `GET`, `PATCH`, `lock`, `unlock`, `unlink-google` theo `isStaffOfManagedBranches` |
| STAFF          | Không có API quản trị                                                                                                                                                                            |

`isStaffOfManagedBranches`: user bị thao tác **chỉ có vai trò STAFF** và **mọi** chi nhánh của họ đều do MANAGER này quản lý. Vì vậy STAFF làm ở cả chi nhánh khác thì MANAGER không thao tác được.

Người thao tác đọc từ DB bằng `loadActor`, không từ token, chỉ tính vai trò còn hiệu lực. Token còn sống tối đa 15 phút sau khi bị khoá hoặc hạ vai trò: nếu tin token, ADMIN vừa bị khoá tự mở khoá được.

## Quản lý chi nhánh

Controller: `src/admin/branches.controller.ts`. Service: `src/admin/branches.service.ts`.

- `list`: phân trang, sắp theo `code`.
- `create`: tạo chi nhánh, outbox `branch.created`, `AuditLog` trong một transaction. Trùng `code` → `400`, `details.fields`.
- `update`: khoá lạc quan theo `version`, lệch → `409 VERSION_CONFLICT`. Outbox `branch.updated`.
- `deactivate`: UPDATE có điều kiện `isActive = true`, gọi lại → `409 INVALID_STATE`. Outbox `branch.updated` có `isActive = false`. Không xoá `UserBranch`: `ACTIVE_ASSIGNMENTS` bỏ vai trò này khi phát token. User không còn vai trò nào khác thì refresh trả `401`, đăng nhập Google trả `403`.

**Bảng ghi:** `Branch`, `OutboxEvent`, `AuditLog`.

**Đồng thời:** hai request cùng `code`: unique chặn một bên, bắt `P2002` đúng index `Branch_code_key`. Hai lần ngừng hoạt động: UPDATE có điều kiện nên chỉ một lần phát sự kiện. Sự kiện ghi cùng transaction nên rollback thì không có thư.

## Quản lý nhân viên

Controller: `src/admin/users.controller.ts`. Service: `src/admin/users.service.ts`. Mọi thao tác sửa một user đi qua `changeUser`, trong một transaction:

1. `SET LOCAL lock_timeout`, khoá dòng user. Thao tác có thể bớt ADMIN khoá thêm mọi ADMIN (`lockAdminsAndUser`).
2. Đọc user đã khoá, gọi `assertAllowed` trên dữ liệu đó.
3. Thực hiện thay đổi, đọc lại, kiểm ADMIN cuối cùng nếu user là ADMIN (`assertAdminRemains`).
4. Ghi `AuditLog` có `actorId`, `before`, `after` (`toAuditSnapshot`: chỉ ghi `hasPassword`, không ghi hash).

| Thao tác                          | Hàm                  | Thu hồi mọi phiên          | Quy tắc ADMIN cuối cùng |
| --------------------------------- | -------------------- | -------------------------- | ----------------------- |
| Sửa (`version`)                   | `update`             | Không                      | Không                   |
| Khoá                              | `lock`               | Có                         | Có                      |
| Mở khoá                           | `unlock`             | Không                      | Không                   |
| Gỡ Google                         | `unlinkGoogle`       | Có                         | Có                      |
| Đặt lại mật khẩu (chỉ user ADMIN) | `resetPassword`      | Có                         | Không                   |
| Thay vai trò                      | `replaceAssignments` | Khi bớt bất kỳ vai trò nào | Có                      |

`create` không qua `changeUser` vì chưa có dòng để khoá: email lưu chữ thường, chi nhánh phải tồn tại và đang hoạt động (`assertBranchesUsable`), `password` bắt buộc khi và chỉ khi có vai trò ADMIN.

**Mật khẩu đi theo vai trò ADMIN:** thêm ADMIN phải kèm `password`, gửi `password` trong trường hợp khác → `400`; bỏ ADMIN → xoá `passwordHash`. bcrypt luôn chạy ngoài transaction, sau khi đã kiểm quyền.

**Bảng ghi:** `User`, `UserBranch`, `AuthIdentity`, `RefreshToken`, `AuditLog`.

**Đồng thời:** hai request cùng email: unique chặn một bên, bắt `P2002` đúng index `User_email_key`. Refresh đúng lúc thu hồi: thứ tự khoá user rồi token nên `updateMany` thu hồi thấy cả token vừa xoay vòng. Deadlock còn sót lại do `runWithLockRetry` chạy lại tối đa 3 lần; vẫn lỗi hoặc chờ khoá quá 3 giây → `503`.

## Quy tắc ADMIN cuối cùng

File: `src/admin/last-admin.ts`. Áp dụng cho khoá, bỏ vai trò ADMIN, gỡ Google của ADMIN không có mật khẩu.

**ADMIN đang hoạt động** = `ACTIVE`, có vai trò ADMIN, và có mật khẩu hoặc Google. ADMIN không còn cách đăng nhập thì không tính.

1. `lockAdminsAndUser`, gọi **trước** mọi thay đổi: `SELECT ... FOR UPDATE` các dòng `User` của mọi ADMIN đang hoạt động và user bị thao tác, sắp theo id.
2. Thực hiện thay đổi.
3. `assertAdminRemains`, gọi **sau** thay đổi: đếm lại bằng câu lệnh mới; bằng 0 → `409 LAST_ADMIN`, cả transaction rollback.

**Đồng thời:** hai ADMIN cùng hạ vai trò của nhau. Không khoá thì mỗi bên đếm khi chưa thấy thay đổi của bên kia, đều thấy còn 1 ADMIN, cả hai commit và hệ thống còn 0 ADMIN. Có khoá thì bên sau chờ bên trước commit; ở chế độ READ COMMITTED câu đếm sau đó thấy dữ liệu mới, nên nhận `409`. Danh sách khoá đọc từ snapshot cũ cũng không sao, vì việc đếm là câu lệnh riêng chạy sau khi đã có khoá. Sắp theo id để hai bên không khoá ngược thứ tự.

Khi chạy `pnpm test:auth`, test dừng nếu DB có ADMIN ngoài dữ liệu test, vì quy tắc này đếm toàn hệ thống.

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
