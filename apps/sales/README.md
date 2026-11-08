# sales-service — POS tại quầy

Sales chỉ đọc/ghi schema `sales`. Inventory giữ quyền sở hữu hàng và công thức giá.
API công khai đi qua gateway: `docs/api/sales.openapi.yaml`. Tiền dùng `Prisma.Decimal`, JSON là chuỗi.

## Các file

| File                                                          | Trách nhiệm                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/pos/pos-orders.controller.ts`                            | Tạo, đọc lại, xác nhận và huỷ đơn; JWT được kiểm toàn cục                                   |
| `src/pos/pos-customers.controller.ts`                         | Tạo/tìm khách và lịch sử mua theo chi nhánh                                                 |
| `src/pos/pos-customers.service.ts`                            | Chuẩn hoá điện thoại, unique phone, lọc đơn đã thanh toán theo chi nhánh                    |
| `src/pos/pos-orders.service.ts`                               | Điều phối tạo, xác nhận, huỷ; mọi HTTP nằm ngoài transaction                                |
| `src/pos/inventory-stock.client.ts`                           | Quote/deduct/release; zod kiểm phản hồi, timeout 3 giây/lượt, tối đa hai retry lỗi tạm thời |
| `src/core/order-store.ts`                                     | Unique idempotency, lease, transaction chốt dòng bán và trạng thái                          |
| `src/core/order-transactions.ts`                              | UPDATE có điều kiện, lịch sử và outbox trong cùng transaction                               |
| `src/core/order-record.ts`                                    | Quyền chi nhánh, trình bày snapshot, phát lại lỗi tạo đơn                                   |
| `prisma/migrations/20261108150000_sales_pos/migration.sql`    | Một migration thêm Order, OrderItem, OrderStatusHistory, AuditLog và CHECK                  |
| `prisma/migrations/20261108180000_pos_customer/migration.sql` | Thêm Customer và Order.customerId tùy chọn                                                  |

## Tạo hoá đơn: POST /api/pos/orders

1. Body gồm `branchId`, `tagCodes`, `customerId` tùy chọn; bắt buộc `Idempotency-Key`. `OrderStore.open` kiểm quyền STAFF/MANAGER
   đúng chi nhánh hoặc ADMIN toàn hệ thống. Hash gồm chi nhánh, bộ mã tem đã sắp xếp và khách nếu có; không tin giá từ client.
2. Transaction tạo `Order(CREATING)` và `OrderStatusHistory`. Unique `Order.idempotencyKey` giành một id;
   bắt đúng index `Order_idempotencyKey_key`. Trùng nội dung tiếp tục cùng đơn; khác nội dung trả 422.
   Mã đơn mới là `POS` + UUID bỏ dấu gạch, để dùng nguyên mã làm nội dung VietQR; mã đơn cũ vẫn đọc được.
3. `claim` dùng UPDATE có điều kiện giành lease 60 giây theo giờ DB; request còn lại chờ tối đa 35 giây,
   không giữ connection trong lúc chờ. Hết thời gian trả 503 để client gửi lại cùng key.
4. Chủ lease gọi `quote`, ghi `deductionStarted`, rồi gọi `deduct` với `orderId` của dòng Order.
   Giá và tên mẫu cuối cùng lấy từ `deduct`, không dùng giá quote để tính lại tại sales.
5. Transaction chép `OrderItem` (tem, itemId, tên, chỉ, tiền công, giá kim loại, giá đã làm tròn), cộng total bằng
   Decimal, UPDATE `CREATING → PENDING_PAYMENT`, ghi lịch sử và outbox `order.created` có `channel = POS`.
6. Hết hàng: ghi `CANCELLING` cùng mã lỗi/mã tem; bước kế tiếp gọi `release`. Khi kho xác nhận đã trả,
   transaction đổi `CANCELLED`, ghi lịch sử, AuditLog và outbox `order.cancelled`; trả 409 ITEM_NOT_AVAILABLE.
   Đơn thất bại vẫn còn nhưng không có dòng bán. Lỗi hạ tầng giữ 503, thiếu giá giữ METAL_PRICE_NOT_SET.
   Nếu `deduct` đã timeout ở Sales nhưng vẫn đang chạy trong Inventory, `release` chờ khoá theo `orderId`
   và chặn mọi `deduct` đến muộn sau khi đơn được giải phóng.

**Bảng ghi:** `Order`, `OrderItem`, `OrderStatusHistory`, `AuditLog` (khi huỷ), `OutboxEvent`.

**Đồng thời và gián đoạn:** không có mutex trong memory. Hai instance dùng cùng unique key và lease DB.
Lease quá hạn được request cùng key tiếp quản; mọi ghi sau HTTP kiểm đúng chủ lease để tiến trình cũ không
ghi đè tiến trình mới. Nếu đã bắt đầu deduct thì tiếp quản gọi lại deduct (idempotent), không quote chiếc
đã SOLD cho chính đơn rồi nhầm là hết hàng. Nếu release lỗi, giữ CANCELLING để lần gọi sau tiếp tục.
Chưa có job tự tiếp tục đơn dở khi không còn request: cần gửi lại cùng key hoặc gọi lại cancel.

## Đọc lại đơn và khách hàng POS

`GET /api/pos/orders/{id}` và `GET /api/pos/orders/by-key/{key}` chỉ đọc trạng thái/snapshot, kiểm quyền trên
`Order.branchId` thật. Giao diện lưu key trước POST và dùng GET theo key sau reload hoặc timeout; `CREATING` và
`CANCELLING` chưa phải kết quả cuối, chỉ request dùng lại cùng key mới tiếp tục xử lý.

`POST /api/pos/customers` chuẩn hoá số Việt Nam về dạng `0...`, unique `Customer.phone` làm trọng tài khi hai quầy
tạo đồng thời. `GET /api/pos/customers/by-phone/{phone}` tìm khách; cả hai yêu cầu chi nhánh có quyền.
`GET /api/pos/customers/{id}/orders?branchId=...` chỉ trả tối đa 50 đơn `COMPLETED` của chi nhánh được phép.
Đơn không có khách giữ `customerId = null`; không ghi đè tên khách cũ khi tạo trùng số.

## Xác nhận tiền: POST /api/pos/orders/{id}/confirm-payment

`PosOrdersService.confirmPayment` đọc chi nhánh của đơn và kiểm quyền. `OrderStore.confirmPayment` chạy một
transaction: UPDATE `WHERE status = PENDING_PAYMENT` sang `COMPLETED`, tăng version, ghi
`OrderStatusHistory`, outbox `order.paid`. Hai lần song song: đúng một thắng; bên còn lại 409 INVALID_STATE.

**Bảng ghi:** `Order`, `OrderStatusHistory`, `OutboxEvent`. Không gọi inventory và không đổi giá đã chốt.

## Huỷ: POST /api/pos/orders/{id}/cancel

1. Kiểm quyền trên chi nhánh thật của đơn; không nhận branchId từ body để quyết định quyền.
2. `beginCancellation`: transaction UPDATE `PENDING_PAYMENT → CANCELLING`, ghi lịch sử **trước** HTTP.
   Confirm-payment đua với huỷ chỉ có một bên thắng; đơn COMPLETED trả 409 trước khi gọi release.
3. Chủ lease gọi release ngoài transaction; thành công mới `finishCancellation` ghi CANCELLED, lịch sử,
   AuditLog và outbox `order.cancelled`. Gọi lại khi CANCELLING tiếp tục; đã CANCELLED trả 409.

**Bảng ghi:** `Order`, `OrderStatusHistory`, `AuditLog`, `OutboxEvent`. Dòng bán giữ snapshot để truy vết.

## Test

`pnpm test:sales`: PostgreSQL thật đã chạy trên 127.0.0.1:5432, cấu hình từ `.env` root như `tests/inventory`.
Test migrate deploy bằng user riêng, chạy hai instance sales và controller inventory đã build qua HTTP,
không bật worker RabbitMQ. Tiền tố `POSTEST-`; dừng khi thấy dữ liệu cũ, dọn theo key/UUID của chính lần chạy,
so sánh số dòng trước/sau. Test dùng cặp khoá JWT tạm riêng, không đọc khoá đăng nhập thật.

Các ca: tranh một tem 10 vòng, cùng key song song, xác nhận hai lần, huỷ sau thanh toán, xác nhận đua huỷ,
tiếp tục release bị gián đoạn, tiếp quản tạo đơn sau crash, timeout còn transaction Inventory, phân quyền/giá giả,
hai quầy tạo cùng số điện thoại, đơn có/không có khách và lịch sử theo chi nhánh.

Chưa làm: hoàn tiền, webhook và job khôi phục nền.
