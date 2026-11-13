# Tài khoản khách và đơn hàng Storefront

## Kết quả triển khai

Storefront có mục **Tài khoản của tôi → Đơn hàng của tôi** tại `/tai-khoan/don-hang`.
Khách đăng nhập bằng email/mật khẩu, tự tải danh sách đơn của mình, phân trang 20 đơn,
hiển thị mã đơn, ngày đặt, tổng tiền, trạng thái và mở chi tiết mà không nhập ID/token.
Có loading, empty, error/retry, giao diện dùng lại thiết kế responsive hiện tại.
Chi tiết tự cập nhật theo chu kỳ trạng thái hiện có; thao tác huỷ dùng cùng điều kiện
chưa nhận tiền của luồng guest. Đơn mới có mã dạng `WEB-YYYYMMDD-XXXXXXXXXXXX`.

Đã triển khai lên Docker development ngày 2026-11-10: hai migration đã áp dụng, Auth/Sales/Gateway/Storefront đã rebuild/recreate và healthy. Kiểm thử thực tế qua HTTP và Chromium đã qua. Xem [báo cáo triển khai Docker](storefront-customer-orders-deployment.md).

## Kiến trúc đã kiểm tra

- Auth trước đây chỉ có `User` nhân viên, `UserBranch` và các vai trò ADMIN/MANAGER/STAFF.
  Password login dành cho ADMIN; Google login dùng tài khoản nhân viên được cấp trước.
  Không có đăng ký/đăng nhập customer và không có controller `/shop/auth` dù Gateway đã dành route.
- Thư viện JWT đã hỗ trợ hai audience `backoffice` và `shop`; claims khách dùng `sub`
  là tài khoản và `branches: []`. Tái sử dụng RS256, guard, key/config hiện có.
- Sales sở hữu đơn POS `Order` và đơn website `OnlineOrder`; không dùng chung bảng đơn.
- `sales.Customer` là hồ sơ khách POS theo số điện thoại, liên kết với `Order` POS.
  Số điện thoại đó không phải bằng chứng xác thực tài khoản Storefront.
- Checkout website trước đây là guest: client tạo capability 32 byte, Sales lưu SHA-256
  trong `OnlineOrder.accessHash`. Các API `/shop/orders`, `by-key`, chi tiết và huỷ dùng
  `Authorization: Checkout ...`. Không có liên kết tài khoản trên đơn online.
- Storefront giữ capability trong sessionStorage của tab tối đa 72 giờ. Đó là lý do
  giao diện cũ cần ID từ liên kết và mã truy cập riêng để mở lại đơn.
- Gateway viết lại `/api/shop` sang Sales, `/api/shop/auth` sang Auth, chuyển tiếp
  Authorization/cookie, loại bỏ header `x-user-*` do client tự khai. Service tự xác thực JWT.

## Liên kết trước và sau

Trước: `sales.OnlineOrder → accessHash`, không có tài khoản.

Sau:

- `auth.CustomerAccount`: tài khoản khách riêng, email chuẩn hoá duy nhất và bcrypt hash.
- `auth.CustomerSession`: refresh token chỉ lưu hash, cookie `rt_shop` HttpOnly/Secure/
  SameSite=Strict, Path `/api/shop/auth`; access token trong bộ nhớ trình duyệt.
- `sales.OnlineOrder.accountId`: UUID tham chiếu đến tài khoản Auth, nullable; có index
  `(accountId, createdAt, id)`. Không tạo foreign key xuyên database/service.
- Đơn mới của khách đăng nhập lấy accountId từ JWT đã kiểm chữ ký/audience; không nhận
  accountId/customerId từ body hoặc query. Replay cùng key nhưng khác tài khoản bị từ chối 422.
- Token nhân viên không dùng được cho API đơn khách và token khách không dùng được ở API nhân viên.
- Chi tiết/lấy danh sách/huỷ đều lọc accountId ở Sales. Huỷ khoá hàng trước khi kiểm trạng thái.
- Không tự động ghép tài khoản với POS Customer hoặc đơn guest theo tên/email/số điện thoại.

Auth đăng ký rõ ràng theo yêu cầu khách; truy cập trang hoặc đăng nhập sai không tự tạo tài khoản.
Refresh riêng cho khách dùng hạn trượt 7 ngày, tối đa 30 ngày, xoay token một lần bằng
atomic update; xung đột gần nhau trả 409 và client thử lại một lần. Cookie/session nhân viên giữ nguyên.
Nếu không xác minh được phiên hiện có do lỗi kết nối/hết hạn, checkout không tự hạ xuống guest.

## API

Quy ước `/api/shop` hiện có được giữ lại thay vì tạo namespace `/api/orders` khác.

| Method | Gateway endpoint | Chức năng |
| --- | --- | --- |
| POST | `/api/shop/auth/register` | Đăng ký khách bằng fullName, email, password |
| POST | `/api/shop/auth/login` | Đăng nhập khách |
| POST | `/api/shop/auth/refresh` | Xoay cookie refresh của khách |
| POST | `/api/shop/auth/logout` | Thu hồi refresh session hiện tại và xoá cookie |
| GET | `/api/shop/auth/me` | Hồ sơ từ JWT shop đã xác minh |
| GET | `/api/shop/my-orders?page=1&pageSize=20` | Danh sách của JWT sub; mới nhất trước, tie-break theo id |
| GET | `/api/shop/my-orders/:id` | Chi tiết thuộc tài khoản; trả 404 cả khi không có hoặc của người khác |
| POST | `/api/shop/my-orders` | Đặt đơn gắn tài khoản; JWT shop + X-Checkout-Authorization + Idempotency-Key |
| POST | `/api/shop/my-orders/:id/cancel` | Huỷ đơn của mình, giữ điều kiện bảo vệ thanh toán hiện có |

`page` từ 1 đến 100000, `pageSize` từ 1 đến 50. Danh sách trả
`{ items, total, page, pageSize }`; không có đơn trả items rỗng.
Các API cá nhân dùng `Cache-Control: no-store`.

Capability của checkout tiếp tục phục vụ idempotency/recovery và cơ chế guest an toàn cũ.
Các API guest `/api/shop/orders*` giữ nguyên. Trang tra cứu guest được giữ riêng tại
`/don-hang/khach`; liên kết `/don-hang/:orderId` cũ vẫn hoạt động.

Đặc tả request/response: `docs/api/shop.openapi.yaml` và `libs/contracts/src/customer-account.ts`.

## Migration và dữ liệu

1. Auth: `apps/auth/prisma/migrations/20261110090000_customer_accounts/migration.sql`
   tạo CustomerAccount và CustomerSession, chỉ có FK nội bộ Auth.
2. Sales: `apps/sales/prisma/migrations/20261110090000_online_account/migration.sql`
   thêm accountId nullable và index; không cập nhật hoặc xoá đơn hiện có.

Đã đọc số lượng thực tế trên Sales PostgreSQL đang chạy trước khi kiểm migration:
0 OnlineOrder, 0 POS Customer, 2 Order POS. Không đọc/đưa thông tin cá nhân vào báo cáo.
Cả hai migration đã được PostgreSQL chấp nhận trong `BEGIN ... ROLLBACK` với lock timeout 3 giây.
Bước kiểm source ban đầu không reset database, xoá volume hoặc apply migration bền vững. Hai migration sau đó đã được áp dụng khi triển khai Docker; xem báo cáo triển khai.
Do chưa có đơn online thực trong database hiện tại, tương thích guest/đơn online cũ còn được
kiểm bằng fixture và thiết kế migration nullable ở giai đoạn source. Sau triển khai Docker đã tạo và kiểm tra đơn online thật; xem báo cáo triển khai.

Khi triển khai, chạy migration Auth và Sales theo quy trình database đang sử dụng trước khi
chạy app build mới. Chú ý workspace đang có nhiều thay đổi/migration Buyback từ công việc trước;
`prisma migrate deploy` sẽ áp dụng mọi migration pending của service, không chỉ hai migration này.

## Kiểm thử

- Typecheck, lint, build: Contracts, Auth, Sales, Gateway và Storefront đều qua.
- `pnpm --filter @jewelry/auth test:customers`: 3 test qua; đăng ký rõ ràng, password,
  JWT đúng/sai audience, cookie riêng, refresh/replay/logout, handler Sales yêu cầu xác thực.
  Bộ này import controller đã build ở Auth/Sales, cần build cả hai trước khi chạy.
- `pnpm --filter @jewelry/sales test:online`: 13 test qua; tạo đơn, saga/outbox,
  idempotency, A/B ownership, danh sách rỗng/phân trang/thứ tự mới nhất, guest,
  huỷ của tài khoản và chặn huỷ sau nhận tiền.
- `pnpm --filter @jewelry/sales test:online-payments`: 17 test qua; thu tiền, callback
  Inventory, đối soát/hoàn tiền và phân quyền nghiệp vụ hiện có.
- `pnpm --filter @jewelry/storefront test`: 40 test qua; bao gồm checkout dùng JWT,
  trang tài khoản yêu cầu đăng nhập, danh sách/chi tiết/empty/loading/error và guest riêng.
- Bộ test Auth và Gateway hiện có đều qua; test routing/rate limit cá nhân cũng qua.
  Lần đầu runner bị sandbox chặn spawn Node; đã chạy lại ngoài hạn chế này thành công.
- OpenAPI của cả 5 service hợp lệ; schema Shop sinh từ Zod được kiểm tra khớp.
- Migration đã được kiểm bằng transaction rollback ở giai đoạn source. Khi triển khai Docker đã chạy thêm 14 kiểm tra HTTP Auth→Gateway→Sales và 11 kiểm tra Chromium trên ứng dụng thật; xem báo cáo triển khai.

## File thay đổi trong tác vụ này

Auth:

- `apps/auth/package.json`
- `apps/auth/prisma/schema.prisma`
- `apps/auth/prisma/migrations/20261110090000_customer_accounts/migration.sql`
- `apps/auth/src/session/customer-auth.controller.ts`
- `apps/auth/src/session/access-token.service.ts`
- `apps/auth/src/session/session.module.ts`
- `apps/auth/test/customer-accounts.test.mjs`

Sales:

- `apps/sales/prisma/schema.prisma` (chỉ accountId/index của OnlineOrder trong tác vụ này)
- `apps/sales/prisma/migrations/20261110090000_online_account/migration.sql`
- `apps/sales/src/app.module.ts`
- `apps/sales/src/online/my-orders.controller.ts`
- `apps/sales/src/online/online-orders.service.ts`
- `apps/sales/test/online-checkout.test.mjs`

Gateway:

- `apps/gateway/src/proxy/routes.ts`
- `apps/gateway/src/proxy/rate-limit-rules.ts`
- `apps/gateway/src/proxy/checkout.test.ts`

Storefront:

- `apps/storefront/src/App.tsx`
- `apps/storefront/src/api/account.ts`
- `apps/storefront/src/api/shop.ts`
- `apps/storefront/src/pages/account.tsx`
- `apps/storefront/src/pages/checkout.tsx`
- `apps/storefront/src/components/layout.tsx`
- `apps/storefront/src/styles.css`
- `apps/storefront/test/storefront.test.mjs`

Contracts và tài liệu:

- `libs/contracts/src/customer-account.ts`
- `libs/contracts/src/index.ts`
- `libs/contracts/src/openapi.ts`
- `docs/api/shop.openapi.yaml`
- `docs/storefront-customer-orders.md`

Không sửa nghiệp vụ thanh toán, tồn kho, Buyback hoặc giao diện Backoffice trong tác vụ này.
Không commit/push. Các thay đổi có sẵn trong workspace được giữ lại.

## Giới hạn

- Chưa có quy trình xác minh email, quên mật khẩu hoặc chủ động liên kết đơn guest/POS cũ;
  không nhận diện chủ đơn cũ qua thông tin liên hệ chưa xác minh.
- Mỗi dòng OnlineOrderItem là một chiếc trang sức đã giữ, nên chi tiết hiển thị số lượng 1/dòng
  và đơn giá tương ứng, không tự suy đoán số lượng/giá trước phản hồi giữ hàng từ Inventory.
- Giữ nguyên hướng dẫn thanh toán hiện tại: không tạo tài khoản ngân hàng/QR hay nghiệp vụ giao hàng giả.
- Đăng xuất thu hồi refresh session; access JWT hiện có sống tối đa 15 phút như kiến trúc JWT hiện tại.
- Đã triển khai vào Docker development. Hiện không có sản phẩm được công bố online/kho nhận đơn online; các đơn smoke được tạo thật nhưng kết thúc CANCELLED / ITEM_NOT_AVAILABLE, chưa kiểm được nhánh giữ hàng thành công trên dữ liệu hiện tại.

## Phân quyền nhân viên và quản lý (giải đáp bổ sung)

Backoffice hiện dùng khung giao diện chung với menu/nút theo vai trò, không phải ba app riêng.
STAFF có tồn kho, POS và thu mua theo chi nhánh được cấp; nhập hàng hiện chỉ ADMIN được lập/duyệt và chọn chi nhánh nhận; quyền duyệt/xác nhận
vẫn do backend kiểm riêng. MANAGER có thể được gán nhiều chi nhánh, quản lý STAFF và xem báo cáo
trong phạm vi được giao. ADMIN quản trị toàn hệ thống, tạo/sửa chi nhánh và cấp vai trò.
Tài khoản Storefront khách mua hàng độc lập với các tài khoản này.
