# report-service

Phase 4G chỉ giữ bền vững sự kiện `stock.changed` trong `DeferredStockEvent`.
Consumer chung ghi `ProcessedEvent` và dòng này trong một transaction, rồi mới ack RabbitMQ;
thư trùng không tạo dòng thứ hai. Phase 5 sẽ xây bảng tổng hợp từ dữ liệu đã giữ.

Phase 5: `order.paid` ghi `OrderRevenue` và `OrderLineSales` cùng `ProcessedEvent` trong một
transaction. `order.cancelled` ghi dấu chặn thư paid đến muộn nếu chưa có doanh thu; không xoá
doanh thu đã ghi vì POS chưa có luồng hoàn tiền. `orderId` và `(orderId, tagCode)`
chống cộng trùng kể cả hai eventId khác nhau tới đồng thời. Ngày báo cáo là ngày Việt Nam
(`Asia/Ho_Chi_Minh`), giá bán và giá vốn lấy từ snapshot sự kiện, không truy vấn chéo database.
Đơn cũ thiếu snapshot giá vốn trả `cogs: null`.

Inventory chốt từng kho trong 00:05–00:59 giờ Việt Nam, phát `inventory.snapshot.closed` qua
outbox. Consumer ghi `InventorySnapshotBatch`/`InventorySnapshot` cùng `ProcessedEvent`.
`/api/admin/reports/inventory-snapshots` trả bản chốt nguyên gốc;
`/api/admin/reports/stock-movements` chỉ trả nhập–xuất–tồn khi đủ mốc liền nhau và đối soát đúng.
Nhập = phiếu nhập + trả kho; xuất = bán; `COUNT_MISSING` không làm giảm tồn thực tế.
Thiếu mốc thì `complete=false`, không tự dựng lại lịch sử từ tồn hiện tại.

Gateway chuyển `/api/admin/reports/daily` và `/api/admin/reports/top-products` tới service này.
Hai API nhận `from`, `to` dạng `YYYY-MM-DD` (tối đa 366 ngày), `branchId` bắt buộc cho MANAGER.
ADMIN có thể bỏ `branchId` để xem mọi chi nhánh; STAFF không được xem. Hợp đồng chi tiết ở
`docs/api/report.openapi.yaml`. Report cập nhật bất đồng bộ sau khi consumer nhận event.

## Xuất Excel (Task 5.3A)

`src/orders/report-export.service.ts` dùng lại các hàm báo cáo JSON, tạo ba file Excel qua
`/api/admin/reports/daily.xlsx`, `/top-products.xlsx`, `/stock-movements.xlsx`. Controller
kiểm quyền và ngày trước khi gọi export; ADMIN có thể xem các chi nhánh đã ghi nhận, MANAGER
chỉ chi nhánh được gán. Kỳ xuất tối đa 31 ngày, 1.000 dòng file; dữ liệu tồn kho nguồn tối đa
2.000 dòng snapshot/batch để phù hợp Gateway đang buffer và timeout 10 giây. File tồn kho có
sheet trạng thái riêng cho kho thiếu snapshot, không ghi số liệu giả. `exceljs` chỉ tạo buffer
trong bộ nhớ; không tạo file tạm. Chạy `pnpm --filter @jewelry/report build` rồi
`pnpm --filter @jewelry/report test:excel-export` để kiểm chứng.

## DLQ và phát lại (Task 5.3B)

`dlx` gửi cùng một thư tới DLQ gốc và `report.dlq.observer`. `src/dlq/dlq-observer.ts`
chỉ ack bản sao observer sau khi ghi `DeadLetterRecord` trong PostgreSQL; trang quản trị
không đọc/lấy thư trực tiếp khỏi DLQ gốc. Thư đã vào DLQ **trước khi có binding observer**
không tự xuất hiện trong trang này. `failedAt` là lúc Report lưu bản sao, không phải timestamp
do RabbitMQ tự cung cấp. Lỗi hiển thị là nhóm an toàn, không phải exception thô; payload gốc
chỉ nằm trong DB Report để phát lại, không trả qua API.

ADMIN dùng `GET /api/admin/reports/dlq`, `GET /api/admin/reports/dlq/:id` và
`POST /api/admin/reports/dlq/:id/replay`. `src/dlq/dlq-policy.ts` chỉ cho phép những event có
schema hợp lệ và handler hiện có ở Inventory hoặc Report; queue Sales chưa có consumer nên
không cho replay. Service claim bằng update có điều kiện/lease 60 giây, giới hạn ba lần mỗi
thư. Bản sao được publish tới `domain.events` với routing key từ envelope đã validate và
eventId gốc để consumer dedup. DLQ gốc **không bị ack/xoá** khi replay; publish thất bại hay
crash đều không làm mất thư gốc. `DlqReplayAttempt` ghi ADMIN, thời điểm và trạng thái
`REQUESTED`, `REPUBLISHED`, `PUBLISH_FAILED`, `PUBLISH_UNCONFIRMED`, hoặc
`PROCESSING_FAILED` nếu bản phát lại quay lại DLQ. `REPUBLISHED` chỉ là publisher confirm;
chưa có tín hiệu đáng tin cậy để đánh dấu `PROCESSING_SUCCEEDED`. Không tự retry poison message.

Triển khai topology mới cần nạp lại `infra/rabbitmq/definitions.json` và migration
`20261109090000_dlq_observer` trước khi bật Report. Test có mục tiêu:
`pnpm --filter @jewelry/report build`, `test:dlq`, `test:dlq:rabbit` và
`test:dlq:postgres` (hai ca sau dùng RabbitMQ/PostgreSQL dev, không chạy production).

## Historical backfill (Task 5.4)

Sales xuất snapshot lịch sử theo batch; `report:backfill:import` mặc định dry-run,
chỉ ghi khi có `--apply`. Import và live consumer dùng chung validation/logic ghi
`OrderRevenue`/`OrderLineSales`, unique `orderId` và so sánh snapshot. Dữ liệu khác
được audit conflict, không ghi đè. Có cursor, checkpoint theo hash file và audit JSONL.
Không đọc Sales DB từ Report, không thay vốn thiếu bằng 0.
Xem [runbook](../../docs/phase5-backfill-runbook.md). `test:backfill` là unit có mục tiêu;
integration riêng ở `tests/reporting/`, không thuộc unit suite. Kết quả thực tế ở
`docs/phase5-progress.md`.
