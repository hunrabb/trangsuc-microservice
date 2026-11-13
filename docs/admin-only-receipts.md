# Nhập hàng tập trung bởi ADMIN

Theo yêu cầu thay đổi ngày 2026-11-10, chỉ ADMIN được quản lý phiếu nhập.
ADMIN chọn chi nhánh nhận hàng tại Backoffice → Nhập hàng, lập phiếu nháp, thêm/xoá từng chiếc và duyệt.
STAFF/MANAGER không có menu Nhập hàng, không truy cập được URL phiếu hoặc gọi API phiếu nhập.
Quyền tồn kho, POS và các nghiệp vụ khác giữ nguyên.

## Thực hiện

- Inventory: toàn bộ ReceiptsController có `@Roles('ADMIN')`; ReceiptsService cũng kiểm ADMIN trước khi truy cập dữ liệu để bảo vệ cả caller nội bộ.
- Backoffice: thêm `canManageReceipts`, dùng cho menu, route danh sách/chi tiết và các nút lập/sửa/duyệt phiếu.
  Trang tồn kho vẫn dùng quyền `canBranchStockAccess` hiện có.
- Không thêm bảng, không migration, không sửa dữ liệu phiếu cũ.
- Giữ quy trình `DRAFT → APPROVED`, chống tem trùng/version conflict và transaction tạo tồn kho hiện có.
- Cập nhật đặc tả Inventory, tài liệu nghiệp vụ và test tranh chấp duyệt phiếu dùng ADMIN.

## Kiểm tra source

- Typecheck/lint/build Inventory và Backoffice qua.
- `node apps/inventory/test/receipts-access.test.mjs`: hai test qua, bao gồm chặn mọi thao tác của STAFF/MANAGER trước khi chạm DB và ADMIN chọn hai chi nhánh khác nhau.
- `node apps/backoffice/src/auth/permissions.test.ts`: kiểm quyền nhập hàng/tồn kho qua.
- OpenAPI cả năm service hợp lệ.
- Test Postgres cũ trong `tests/inventory/src/inventory.test.ts` đã đổi actor duyệt sang ADMIN; không chạy runner này vào PostgreSQL legacy đang đóng quyền sau cutover.

## Docker development và kiểm tra thực tế

Đã rebuild/recreate riêng `inventory` và `backoffice`; cả hai healthy. Không chạy migration hoặc tác động Docker volumes.

- 26 kiểm tra HTTP qua Gateway và trực tiếp Inventory đều qua: STAFF/MANAGER bị 403 cho danh sách, chi tiết, tạo, thêm dòng, xoá dòng và duyệt; ADMIN xem danh sách được.
- JWT thử nghiệm có chữ ký hợp lệ và hạn 2 phút, chỉ giữ trong bộ nhớ; không tạo tài khoản hoặc đổi vai trò nhân viên trong DB để kiểm thử.
- Đã thử ADMIN chọn hai chi nhánh, lập phiếu, thêm chiếc và duyệt thành APPROVED; xác minh chiếc IN_STOCK nằm đúng kho nhận.
- Vì môi trường chỉ có một kho hoạt động và chưa có biến thể hoạt động phù hợp, bài kiểm tra chuẩn bị kho/danh mục tạm bên trong transaction. Toàn bộ transaction được rollback.
- Số dòng của 10 bảng (phiếu, dòng phiếu, hàng, chuyển động, audit, kho, kim loại, danh mục, sản phẩm, biến thể) sau test khớp trước test. Không lưu dữ liệu thử vào kho thật.

URL: http://localhost:8080/nhap-hang — đăng nhập ADMIN và tải lại trang để nhận menu mới.
Các image trước triển khai được giữ ở `jewelry/inventory:before-admin-receipts-20261110` và `jewelry/backoffice:before-admin-receipts-20261110`.
