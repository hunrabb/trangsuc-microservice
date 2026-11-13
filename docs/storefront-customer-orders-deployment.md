# Triển khai Storefront Customer Orders — Docker development

Ngày thực hiện: **2026-11-10**, múi giờ Asia/Saigon.

## Kết quả và URL

**Đã triển khai thành công.** Hai migration đã áp dụng bằng Prisma migrate deploy;
Auth, Sales, Gateway và Storefront đã rebuild/recreate và đều healthy.
Không reset database, không xoá Docker volume, không thay đổi cấu hình mở bán online.

| Trang | URL |
| --- | --- |
| Storefront | http://localhost:8081/ |
| Tài khoản / Đơn hàng của tôi | http://localhost:8081/tai-khoan/don-hang |
| Tra cứu đơn guest | http://localhost:8081/don-hang/khach |
| Gateway | http://localhost:3000/health/live |
| Backoffice hiện có | http://localhost:8080/ |

Khách có thể tự đăng ký bằng nút **Chưa có tài khoản? Đăng ký** rồi đăng nhập.
Không cần nhập ID đơn/mã truy cập trong mục đơn hàng tài khoản.

## Kiểm tra trước triển khai

- Đã đọc `docs/storefront-customer-orders.md`, migration SQL, Dockerfile và Compose.
- Project đang chạy: `jewelry`, bốn database độc lập `auth_db`, `sales_db`,
  `inventory_db`, `report_db`; PostgreSQL legacy vẫn được giữ.
- Compose hiện tại: `docker-compose.yml` + `docker-compose.override.yml`.
  Một số container cũ còn mang label Compose của file db-separated; phần service tương ứng
  được đối chiếu và có cùng cấu hình database/network. Không chuyển database hoặc đổi volume.
- Auth trước triển khai: 6 User nhân viên, chưa có bảng CustomerAccount.
- Sales trước triển khai: 2 Order POS, 0 Customer POS, 0 OnlineOrder, 0 OnlinePayment.
- Checksum của toàn bộ migration đã áp dụng khớp với source.
  Chỉ hai migration Customer Orders là pending; các migration Buyback đã được áp dụng từ trước.
- Inventory có 2 chiếc IN_STOCK, 0 sản phẩm publishedOnline, 0 kho acceptsOnlineOrders.

## Sao lưu và phương án quay lui

Custom-format `pg_dump -Fc` của Auth và Sales đã được tạo và kiểm tra đọc được bằng pg_restore.
Bản sao lưu bền vững, bị loại khỏi Git và Docker build context, nằm tại:

```text
secrets/backups/storefront-customer-orders-deploy-20261110-jTwNI2/
  auth_db.dump
  sales_db.dump
  auth-restore-list.txt
  sales-restore-list.txt
```

Thư mục có quyền 700, file backup có quyền 600. Không đưa dữ liệu tài khoản hoặc mật khẩu vào báo cáo.
Không thực hiện restore trong tác vụ này.

Image cũ được giữ với tag:

```text
jewelry/auth:before-customer-orders-20261110
jewelry/sales:before-customer-orders-20261110
jewelry/gateway:before-customer-orders-20261110
jewelry/storefront:before-customer-orders-20261110
```

Nếu cần quay lui app, có thể dùng các image này và giữ schema additive. Không xoá cột/bảng mới
hoặc restore đè database đang có dữ liệu mới khi chưa đối chiếu; backup là điểm trước triển khai,
không chứa tài khoản/đơn phát sinh sau đó.

## Các lệnh triển khai đã chạy

```bash
docker compose -p jewelry -f docker-compose.yml -f docker-compose.override.yml \
  build auth auth-migrate sales sales-migrate gateway storefront

docker compose -p jewelry -f docker-compose.yml -f docker-compose.override.yml \
  run --rm --no-deps auth-migrate

docker compose -p jewelry -f docker-compose.yml -f docker-compose.override.yml \
  run --rm --no-deps sales-migrate

docker compose -p jewelry -f docker-compose.yml -f docker-compose.override.yml \
  up -d --no-deps --force-recreate auth sales gateway storefront
```

`--rm` chỉ xoá container migration dùng một lần; không xoá volume database.
Không chạy `down`, `down -v`, `prune`, `migrate reset`, `db push` hay `--remove-orphans`.

Đã áp dụng đúng:

- Auth: `20261110090000_customer_accounts` — CustomerAccount/CustomerSession và FK nội bộ Auth.
- Sales: `20261110090000_online_account` — accountId nullable và index trên OnlineOrder.

Cả hai có `finished_at` thành công trong `_prisma_migrations` đúng database của service.
Log: [Auth migration](evidence/storefront-customer-orders-20261110/auth-migrate.txt),
[Sales migration](evidence/storefront-customer-orders-20261110/sales-migrate.txt).

## Kiểm thử HTTP thực tế: 14 nhóm kiểm tra PASS

Chạy qua nginx Storefront → Gateway → Auth/Sales, không mock API/database.

| Kiểm tra | Kết quả thực tế |
| --- | --- |
| Chưa đăng nhập / giả header danh tính | 401 |
| Đăng ký và đăng nhập khách A/B | 201 / 200; JWT shop và cookie rt_shop riêng |
| Sai mật khẩu | 401 |
| Khách chưa có đơn | items rỗng, total = 0 |
| Refresh khách | 200; cookie được xoay |
| Tạo 2 đơn A, 1 đơn B, 1 guest | 202; lưu OnlineOrder và owner đúng |
| Gửi lại cùng key/capability | Cùng ID; tài khoản khác sử dụng lại bị 422 |
| Tự gửi accountId trong body | 400 |
| Danh sách/chi tiết/phân trang | Chỉ đơn đúng owner, mới nhất trước, no-store |
| A xem B / B xem hoặc huỷ A | 404; request thiếu JWT nhận 401 |
| Guest không tự liên kết vào tài khoản | API chi tiết tài khoản trả 404 |
| Guest tra cứu/by-key/secret sai | Đúng secret đọc được; secret sai nhận 404 |
| JWT khách gọi namespace nhân viên | 401 |
| Luồng outbox/RabbitMQ/Inventory và logout | Đơn xử lý đúng thiếu hàng; refresh sau logout không còn được chấp nhận |

Ngoài Gateway, gọi trực tiếp Sales `/shop/my-orders` và `/shop/my-orders/:id`
không có JWT cũng nhận **401**, xác nhận Sales tự kiểm xác thực.

Bằng chứng: [HTTP results](evidence/storefront-customer-orders-20261110/http-results.json) và [đối chiếu accountId đã lưu trong database](evidence/storefront-customer-orders-20261110/ownership-results.json).

## Kiểm thử Chromium thực tế: 11 kiểm tra PASS

- Chưa đăng nhập: hiện form đăng nhập, không hiện form ID/capability.
- A đăng nhập: chỉ có hai đơn A.
- Reload trang: khôi phục phiên qua cookie Secure/HttpOnly thật trên localhost.
- Mở chi tiết bằng nút Xem chi tiết, không nhập ID hay secret.
- Thay URL sang đơn B: hiện lỗi không tìm thấy đơn thuộc tài khoản, không lộ chi tiết.
- Logout: dữ liệu đơn A biến mất khỏi giao diện.
- Đăng nhập B: chỉ có đơn B, không thấy cache đơn A.
- Mobile 390×844: không tràn ngang.
- Đăng ký khách mới qua form: thành công và hiện empty state.
- Tra cứu guest qua form bằng ID/capability: mở đúng đơn guest thật.
- Không có lỗi JavaScript runtime trong các trang đã kiểm tra.

Bằng chứng: [Browser results](evidence/storefront-customer-orders-20261110/browser-results.json),
[ảnh desktop](evidence/storefront-customer-orders-20261110/account-orders-desktop.png),
[ảnh mobile](evidence/storefront-customer-orders-20261110/account-orders-mobile.png).

Playwright và các thư viện Chromium được chuẩn bị tạm để kiểm thử, không sửa dependency ứng dụng
hoặc cài package hệ thống. Script/credentials thử nghiệm giữ trong thư mục `/tmp` có quyền truy cập hạn chế;
không đưa access token/capability/mật khẩu vào evidence được lưu trong repo.

## Dữ liệu sau kiểm thử và giới hạn

Run kiểm thử: `customer-orders-1c3b3391`.

- Có 3 CustomerAccount thử nghiệm được đánh dấu rõ bằng tên/email smoke, miền `example.invalid`:
  A, B và một tài khoản đăng ký qua UI.
- Có 4 OnlineOrder thử nghiệm: 3 liên kết tài khoản và 1 guest với accountId null.
- Cả 4 kết thúc **CANCELLED / ITEM_NOT_AVAILABLE**, tổng tiền chưa được xác nhận.
- 0 OnlinePayment; không ghi nhận thanh toán, không tạo doanh thu hoặc đơn CONFIRMED giả.
- Vẫn còn 2 chiếc IN_STOCK; không công bố sản phẩm hoặc bật kho online để ép test thành công.
- Các bản ghi thử nghiệm được giữ lại, không xoá dữ liệu để dọn test.

**Chưa kiểm được nhánh giữ hàng/thanh toán thành công** vì dữ liệu hiện tại chưa được cấu hình bán online.
Việc tạo đơn, liên kết owner, quyền truy cập, lịch sử đơn và guest đã được kiểm thực tế;
không diễn giải HTTP 202 thành đơn đã được giữ hàng hay thanh toán thành công.

Không thay đổi source hoặc quy tắc nghiệp vụ thanh toán, Inventory, Buyback trong tác vụ triển khai này.

## Bảo toàn dữ liệu và hoạt động đồng thời

Bằng chứng: [Preservation results](evidence/storefront-customer-orders-20261110/preservation-results.json).

- Cả 2 Order POS cũ giữ nguyên từng trường khi đối chiếu trực tiếp với backup.
- Cả 6 User nhân viên có trong backup đều còn tồn tại; không mất bản ghi.
- Database containers và tên volume không đổi; tất cả các volume đã ghi nhận trước triển khai vẫn được giữ.
- Tất cả container kiểm tra cuối cùng đều healthy.

Trong lúc build có **hoạt động development khác chạy đồng thời**, được ghi nhận khi kiểm tra:

- Auth có thêm 1 User nhân viên (tổng 7); ngoài ra một User cũ thay đổi status từ LOCKED sang ACTIVE,
  version 2→4 và updatedAt. AuditLog ghi `user.unlocked` lúc **15:06:16** và
  `user.assignments_replaced` lúc **15:06:24**, ngày 2026-11-10, giờ Asia/Saigon.
- Inventory và Backoffice cũng có container ID mới trong cùng thời gian. Có process Compose build Inventory
  độc lập được quan sát, ngoài lệnh triển khai bốn service Customer Orders.

Script Customer Orders chỉ đăng ký CustomerAccount và gọi API khách, không mở khoá/cấp quyền User nhân viên
hoặc recreate Inventory/Backoffice. Các thay đổi đồng thời được giữ lại, không hoàn nguyên công việc khác.
Vì vậy không khẳng định fingerprint toàn bảng User không đổi; các cột thay đổi đã được ghi rõ ở trên.
