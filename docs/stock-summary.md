# Tồn kho theo mẫu / biến thể

Ngày triển khai: 10/11/2026. Áp dụng repository trangsuc-microservice hiện tại (tên vangbac-microservice trong yêu cầu là tên tham chiếu).

## Giao diện

Backoffice `/ton-kho` có hai chế độ: **Theo mẫu / biến thể** (mặc định) và **Theo mã tem**. Một dòng tổng hợp là một ProductVariant trong chi nhánh được chọn; biến thể được trình bày cùng tên Product, SKU và kim loại. Các biến thể không có chiếc nào không xuất hiện. Không cộng nhiều biến thể thành một dòng Product để tránh mất thông tin SKU/kim loại.

Bộ chọn chi nhánh và biến thể dùng lại Backoffice hiện tại. Nút **Xem mã tem** chuyển sang danh sách chiếc cùng biến thể, cùng chi nhánh, xoá bộ lọc trạng thái và về trang 1. Đổi chi nhánh khởi tạo lại bộ lọc/trang, không hiển thị cache của chi nhánh trước. Danh sách tem giữ thông tin trọng lượng, tiền công, giá vốn theo quyền, trạng thái và in tem; bổ sung cột chi nhánh. Có loading, empty, error/retry và pagination. Không có chế độ cộng toàn hệ thống trong thay đổi này.

## API và cách tính

Bổ sung `GET /api/admin/inventory/items/summary?branchId=<UUID>&page=1&pageSize=20&variantId=<UUID tùy chọn>` qua Gateway hiện có. Endpoint cũ của POS/Online/Exchange và listItems không thay đổi.

Một câu SQL CTE tính toàn bộ tổng và trang từ một snapshot PostgreSQL. Join JewelryItem → Warehouse, ProductVariant → Product → Category và Metal. EXISTS kiểm tra reservation/giá, tránh join nhân bản chiếc theo lịch sử. Nhóm theo biến thể và chi nhánh, sắp xếp theo tên mẫu/SKU/id ổn định. Không tải toàn bộ chiếc vào frontend, không N+1.

- `total`: tất cả JewelryItem của biến thể trong chi nhánh, gồm cả đã bán.
- `available`: IN_STOCK; kho, biến thể, mẫu, danh mục, kim loại đang hoạt động; có MetalPrice hiệu lực (`effectiveFrom <= now()`, cùng tiêu chí thời gian của findCurrentPrice). Đây là khả dụng chung tại chi nhánh, không phải số bán online sau buffer/publish.
- `reserved`: RESERVED với StockReservationItem.isActive và StockReservation ACTIVE/PAID_HELD chưa hết hạn; hoặc ExchangeHold ACTIVE/PROTECTED chưa hết hạn.
- `sold`: SOLD. POS hiện deduct chuyển sang SOLD trước bước nhân viên xác nhận tiền, nên không diễn giải con số này thành số giao dịch đã thu tiền; không thay nghiệp vụ POS.
- `pendingMelt`: PENDING_MELT, không bán được.
- `other`: IN_STOCK ngừng hoạt động/chưa có giá hoặc RESERVED không có hold hiệu lực (hết hạn/chờ đối soát/lịch sử không hoạt động). Không tự trả những chiếc này về khả dụng.

Tổng các nhóm bằng total với ItemStatus hiện tại. Không tạo quy tắc trạng thái ở frontend. Không thay đổi ReservationExpiryWorker, chính sách bảo vệ thanh toán, thu mua/đổi hàng, idempotency, audit hay Outbox/RabbitMQ. Xem SQL trong StockService.summary và logic giữ hàng gốc tại online/reservations.ts, online/payment-events.ts, stock/exchange-holds.service.ts.

## Phân quyền và database

branchId bắt buộc qua Zod. StockService.summary gọi assertListScope trước truy vấn: ADMIN hệ thống được chọn chi nhánh, MANAGER/STAFF chỉ được xem chi nhánh được cấp trong token. SQL lọc branchId trước aggregate, không tải dữ liệu khác chi nhánh để ẩn trên UI. Không trả giá vốn trong summary.

Không sửa Prisma schema/migration, không tạo cột quantity/bảng tổng hợp, không reset database hoặc xoá Docker volume. Giữ nguyên mọi thay đổi có sẵn trong worktree, không commit/push, không thực hiện chuyển schema public.

## File triển khai

- Backend: apps/inventory/src/stock/stock.controller.ts, stock.service.ts.
- Contracts: libs/contracts/src/inventory-api.ts, openapi.ts.
- Frontend: apps/backoffice/src/api/inventory-endpoints.ts, pages/stock-page.tsx, pages/stock-summary-table.tsx.
- API: docs/api/inventory.openapi.yaml.
- Tests: apps/inventory/test/stock-summary.test.mjs, apps/backoffice/test/stock-summary-render.test.mjs; thêm script test:stock-summary vào package.json hai app.
- Tài liệu: README Inventory, Backoffice và docs/stock-summary.md.

## Kiểm chứng

- Typecheck, build, lint cho Inventory/Backoffice/Contracts và dependency: PASS (12/12 tác vụ). Có cảnh báo bundle Backoffice >500 kB.
- Test hồi quy Inventory/Backoffice/Contracts: PASS (6/6 tác vụ).
- Test mới backend: 3/3 PASS, không skip, gồm quyền chi nhánh và SQL thật PostgreSQL với nhiều trạng thái, online ACTIVE/PAID_HELD, Exchange ACTIVE/PROTECTED, expiry, lịch sử trùng, phân trang, thêm chiếc, bán chiếc, mẫu ngừng hoạt động và giá tương lai.
- Test mới frontend: 2/2 PASS (SSR dữ liệu thật từ props và callback drilldown chọn đúng variantId).
- OpenAPI validate: 5/5 PASS; bộ sinh schema Inventory --check PASS; git diff --check PASS.
- Sandbox ban đầu chặn kết nối PostgreSQL/tạo tiến trình Node (EPERM); đã chạy lại các test đó với quyền phù hợp và đạt. Không khởi động Docker hoặc chạy load test.
- Log: /tmp/stock-summary-verified.log, /tmp/stock-summary-regression-final.log, /tmp/stock-summary-postgres.log, /tmp/stock-summary-ui.log, /tmp/stock-summary-openapi.log.

Test PostgreSQL opt-in dùng STOCK_SUMMARY_TEST_URL: chỉ tạo bảng TEMP trong một connection, chạy SQL thực của service với schema thay bằng pg_temp, luôn ROLLBACK. Không sửa dữ liệu Inventory có sẵn; chưa kiểm tra end-to-end qua HTTP hay ràng buộc/FK của schema production.

Chưa deploy/rebuild Docker và chưa browser QA. Sau khi build/deploy riêng Inventory và Backoffice, giao diện ở http://localhost:8080/ton-kho; không khẳng định container hiện tại đã có phiên bản mới.
