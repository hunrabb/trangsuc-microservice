# Gỡ chức năng kiểm kê khỏi phạm vi đồ án

Ngày: 10/11/2026.

## Phạm vi và dependency

Đã gỡ chức năng Stocktaking/Stock Count khỏi ứng dụng. Backoffice không còn menu hoặc route `/kiem-ke`, API Inventory không còn nhận tạo/xem/quét/đóng phiên `/admin/stock-counts`. Đường cũ ở Backoffice đi vào trang không tìm thấy hiện có.

Luồng cũ dùng Prisma trực tiếp trong `StockCountService`, không có repository riêng. Controller/service chỉ được đăng ký trong `InventoryModule`. DTO/validation và kiểu phản hồi chỉ được dùng bởi controller/service, client Backoffice và bộ sinh OpenAPI. Đã gỡ các thành phần này và test database riêng của chức năng.

Không có event, binding RabbitMQ, consumer hoặc outbox riêng cho kiểm kê. Không sửa topology hay messaging. Luồng cũ ghi AuditLog và StockMovement loại COUNT_MISSING nhưng không thay đổi trạng thái JewelryItem. Giữ nguyên hạ tầng audit, phân quyền chi nhánh, mã tem, tồn kho, nhập hàng, POS, online, thu mua, đổi hàng và thanh toán. Không thêm hoặc sửa nghiệp vụ điều chuyển (ngoài phạm vi hiện tại của dự án).

Chốt tồn kho đêm InventoryDailyClose và báo cáo nhập–xuất–tồn độc lập với kiểm kê, tiếp tục hoạt động. COUNT_MISSING lịch sử vẫn không làm giảm tồn thực tế; không xoá hoặc diễn giải lại các movement và audit cũ.

## Database và phương án migration

**Không tạo hoặc chạy migration; không thay schema database; không xoá dữ liệu hoặc Docker volume.**

Giữ nguyên các model StockCount, StockCountLine, StockCountExtra, enum StockCountStatus/StockCountLineStatus, Warehouse.stockCounts, MovementType.COUNT_MISSING và migration lịch sử 20261107180000_inventory_stock_count. Các model này chỉ mô tả dữ liệu lưu trữ, không còn chức năng ứng dụng ghi/đọc phiên kiểm kê. Quan hệ Warehouse → StockCount vẫn giữ quy tắc hạn chế xoá kho khi có lịch sử, như trước.

Nếu cần dọn database sau này: kiểm tra số lượng bản ghi và phiên OPEN bằng truy vấn chỉ đọc; sao lưu và xác định thời gian lưu trữ; trình duyệt migration mới riêng (không sửa migration đã áp dụng). Chỉ sau khi được duyệt mới cân nhắc chuyển dữ liệu sang vùng lưu trữ hoặc xoá bảng con rồi bảng cha và các enum riêng. Giữ StockMovement/AuditLog và COUNT_MISSING nếu còn dữ liệu lịch sử; không dùng DROP CASCADE hoặc reset database. Phương án đó chưa được thực hiện trong thay đổi này.

## File thuộc thay đổi

Xoá:

- apps/backoffice/src/pages/stock-counts-page.tsx
- apps/backoffice/src/pages/stock-count-detail-page.tsx
- apps/inventory/src/stock-count/stock-count.controller.ts
- apps/inventory/src/stock-count/stock-count.service.ts
- tests/inventory/src/stock-count.test.ts

Sửa code:

- apps/backoffice/src/App.tsx
- apps/backoffice/Dockerfile (build contracts trước Backoffice để image Docker chứa giao diện mới)
- apps/backoffice/src/layout/app-shell.tsx
- apps/backoffice/src/auth/permissions.ts (chú thích, giữ nguyên quyền dùng chung)
- apps/backoffice/src/api/inventory-endpoints.ts
- apps/backoffice/src/api/inventory-queries.ts
- apps/inventory/src/inventory.module.ts
- libs/contracts/src/inventory-api.ts
- libs/contracts/src/openapi.ts
- tests/integration/src/correlation.test.ts (kiểm tra bốn endpoint cũ trả 404)

Sửa tài liệu:

- README.md, CLAUDE.md
- apps/backoffice/README.md, apps/inventory/README.md
- docs/thiet-ke.md, docs/ke-hoach.md, docs/phase5-progress.md
- docs/api/inventory.openapi.yaml, docs/api/report.openapi.yaml
- docs/stocktaking-removal.md

Các thay đổi thu mua/đổi hàng và database separation có sẵn trong worktree được giữ nguyên. Không commit/push. Đã build lại image và thay riêng hai container Inventory, Backoffice bằng `docker compose up -d --no-deps --no-build inventory backoffice`; không chạy migration hoặc thay database, RabbitMQ, volume.

## Kiểm chứng

- `pnpm lint`: PASS, 15/15 tác vụ; chạy thêm lint integration sau khi thêm regression: PASS.
- `pnpm exec turbo run typecheck --concurrency=2`: PASS, 27/27 tác vụ.
- `pnpm exec turbo run build --concurrency=2`: PASS, 14/14 tác vụ. Backoffice có cảnh báo bundle lớn, không làm build thất bại.
- `pnpm openapi:validate`: PASS, 5/5 tài liệu. `node scripts/openapi-generate.mjs --check`: PASS.
- Integration nhóm correlationId/Inventory: PASS 5/5; gồm bốn endpoint kiểm kê cũ (POST tạo, GET chi tiết, POST scan, POST close) trả 404, không cần database thật.
- Test bổ sung: chốt tồn đêm 1/1; intake thu mua 18/18; định giá 12/12; settlement/đổi hàng/thanh toán 4/4; frontend thu mua/đổi hàng 19/19. Tổng 54/54 PASS.
- `git diff --check`: PASS.
- Bộ test toàn repo (`pnpm exec turbo run test --concurrency=2`): **FAIL**, 20/21 tác vụ đạt. Test có sẵn `service chưa có consumer thì không bị ràng buộc pool` tại tests/integration/src/correlation.test.ts dùng Sales với DATABASE_POOL_MAX=14. Sales hiện có consumer và yêu cầu ít nhất 15, nên khởi động thoát mã 1. Không sửa cấu hình bảo vệ pool hoặc test ngoài phạm vi này. Nhóm regression liên quan đã chạy riêng và đạt 5/5.

Lượt test đầu trong sandbox bị EPERM khi tạo tiến trình Node; đã chạy lại ngoài sandbox. Build/typecheck ban đầu chạy với mức song song mặc định gây áp lực tài nguyên; đã dừng và chạy lại giới hạn hai tác vụ, kết quả cuối ở trên. Docker build Inventory và Backoffice đều PASS sau khi sửa thứ tự build contracts; hai container mới healthy. Kiểm tra bản Backoffice đang phục vụ dùng bundle `index-BZeYksb7.js` và không chứa route `/kiem-ke`; Inventory runtime trả HTTP 404 cho `GET /admin/stock-counts`. Không chạy integration PostgreSQL/RabbitMQ có ghi dữ liệu hoặc browser E2E. Vì bộ test toàn repo còn lỗi có sẵn nêu trên, chưa thể tuyên bố toàn bộ kiểm thử hệ thống sạch lỗi.

Log ở `/tmp/stocktaking-{lint,typecheck-final,build-final,test-final,openapi,removal-integration,close,buybacks,appraisal,settlement,buyback-ui}.log`.
