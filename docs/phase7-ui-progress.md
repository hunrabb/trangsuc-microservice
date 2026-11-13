# Phase 7 UI — Task 7.UI-A: Quản lý thu mua vàng cũ

**Trạng thái 2026-11-10: đã triển khai frontend Backoffice theo contract Phase 7.1/7.2.** Môi trường development đang dùng bốn PostgreSQL sau cutover; task này không ghi fixture, sửa backend/Prisma, chuyển DB hoặc đụng volume.

## Màn hình và route

| Route | Nội dung |
|---|---|
| `/thu-mua` | Danh sách theo chi nhánh đang làm việc, phân trang 20 dòng, lọc trạng thái và ngày tiếp nhận; mã phiếu, khách, số món, trạng thái, ngày, ID người tiếp nhận, liên kết chi tiết; loading/empty/error. |
| `/thu-mua/moi` | Tiếp nhận khách mới hoặc customerId đã có, 1–20 món, nguồn/tem tham chiếu, kim loại, mô tả, tình trạng, trọng lượng khai/đo ban đầu (chỉ), ghi chú. Validate bằng `createBuybackSchema`; tạo với Idempotency-Key, tra `by-key` khi kết quả mạng chưa rõ, giữ cùng body/key khi thử lại. |
| `/thu-mua/:buybackId` | Thông tin phiếu/món/audit, sửa DRAFT, gửi kiểm định, huỷ có lý do, kiểm định từng món theo revision/version, chọn policy và lập báo giá, xem snapshot tiền từ backend, duyệt/từ chối có xác nhận/lý do. |

Sidebar chỉ hiện mục **Thu mua vàng cũ** cho ADMIN hoặc STAFF/MANAGER có chi nhánh; route có cùng `RequireAuth`/`RequireRole` và `WorkingBranchLayout` như POS. Backend vẫn kiểm tra quyền và version. UI ẩn thao tác sai trạng thái và chặn tự duyệt nếu người dùng là người tiếp nhận, kiểm định hoặc lập giá, kể cả ADMIN. Khi kiểm định thay đổi, query phiếu, kiểm định, báo giá được refetch; tiền chính thức chỉ hiển thị từ quote backend dưới dạng chuỗi Decimal, không tính bằng floating point.

## API đã nối

Gateway `/api/admin/sales/branches/:branchId/buybacks`: `GET` list/detail/by-key, `POST` create/submit/cancel, `PUT` update; `GET` appraisals/quotes/price-policies; `PUT` item appraisal; `POST` quote/approve/reject. Danh sách kim loại lấy từ Inventory `GET /api/admin/inventory/metals`. Các request tạo, kiểm định, báo giá và quyết định dùng Idempotency-Key theo controller hiện tại; update/submit/cancel dùng version đúng contract. Các mutation invalidate query liên quan.

## Giới hạn API và kiểm chứng

- API danh sách không có tìm kiếm, tổng tiền duyệt hay tên người phụ trách; UI không tự thêm bộ lọc hoặc giá giả. Danh sách hiển thị ID người tiếp nhận, còn tiền duyệt/nguồn giá xem ở chi tiết quote. API policy chỉ trả ID kim loại và policy; trước khi lập quote, giá mua live là endpoint nội bộ Inventory nên UI chỉ có thể cho biết backend sẽ chụp giá tại thời điểm quote.
- Chưa có UI quản trị policy hay chi tiền/đổi hàng trong Task 7.UI-A. Các thao tác đó thuộc phạm vi khác.
- Unit/API layer và SSR component tests dùng network mock, không ghi DB. Chưa kiểm chứng thao tác click đầy đủ bằng trình duyệt thật hoặc HTTP end-to-end có dữ liệu Phase 7 trên development; cần môi trường/fixture kiểm thử riêng trước khi coi là browser acceptance.
- `pnpm --filter @jewelry/backoffice test:buybacks`: **11/11 PASS** (API layer, form/contract, permission, maker-checker, kiểm định, báo giá và SSR loading/empty/error). `typecheck` và `lint` Backoffice PASS. Thay đổi bổ sung nhãn `PENDING_MELT` cho kho/POS vì contract Inventory Phase 7 đã mở rộng enum này. Không chạy Docker/backend suite hoặc ghi DB.

## Task 7.UI-B — thanh toán thu mua và đổi trang sức (2026-11-10)

**Trạng thái: PARTIAL cho demo end-to-end.** Frontend đã nối API thật và các kiểm tra frontend PASS, nhưng chưa chạy browser E2E trên môi trường test và API chỉ cho đọc settlement mới nhất, không có audit/retry thủ công đầy đủ. Không đụng DB, Prisma, Compose hoặc task schema `public` đang BLOCKED.

- Route giữ nguyên `/thu-mua/:buybackId`; thêm đường nhảy ngay trên trang đến phần **Thanh toán và đổi trang sức**. Từ danh sách vẫn vào chi tiết theo mã phiếu.
- Từ quote `APPROVED`, lập settlement trực tiếp hoặc chọn tem `IN_STOCK` của chi nhánh từ Inventory. UI tra giá bán theo tem, còn giá bán chốt, chênh lệch dương/âm/0, chiều và số tiền phải thu/chi lấy nguyên văn từ Sales. Không tính tiền bằng JavaScript floating-point.
- Ghi chứng từ và bằng chứng thủ công ở `AWAITING_PAYMENT`; badge `PAYMENT_RECORDED` nói rõ chưa hoàn tất. Chỉ MANAGER/ADMIN khác người lập và người ghi chứng từ mới thấy nút xác nhận hợp lệ. Xác nhận có modal và mã đối chiếu/ghi chú. Có hủy trước ghi tiền theo contract. Các lệnh tài chính dùng idempotency key giữ nguyên khi timeout và chặn click đôi trong cùng phiên thao tác.
- Hiển thị `RESERVING`, `FULFILLING`, `CANCELLING`, `RECONCILIATION_REQUIRED`, `SETTLED` theo backend; khi cần đối soát chỉ có tải lại trạng thái/hướng dẫn chờ worker, không tạo nút retry không có API. Hiển thị mã settlement, mã đơn bán nếu có, tem đổi, tác nhân, mốc thời gian backend trả về; không suy diễn thời điểm ghi chứng từ.
- Lịch sử trên trang gồm audit 50 mốc gần nhất của phiếu, báo giá/duyệt/từ chối tối đa 50 bản, và kiểm định mới nhất mỗi món. Màn hình ghi rõ backend chưa có endpoint đọc các phiên bản kiểm định cũ, toàn bộ audit settlement hoặc các settlement đã hủy trước giao dịch mới nhất.

API qua Gateway dùng chung `api`/`buybackApi`: `GET/POST /api/admin/sales/branches/:branchId/buybacks/:id/settlements`, `POST /:id/exchanges`, `POST /:id/settlements/:settlementId/{payment,confirm,cancel}`. Inventory dùng `GET /api/admin/inventory/items?branchId=&status=IN_STOCK&page=&pageSize=` và `GET /api/admin/inventory/items/by-tag/:tagCode`. Các lỗi `FORBIDDEN`, `VERSION_CONFLICT`, `PAYMENT_REFERENCE_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, mạng/timeout được hiển thị; version conflict cho tải lại phiếu/quote/settlement.

File UI-B: `apps/backoffice/src/buybacks/{api.ts,api.test.ts,model.ts,detail-page.tsx,quote-panel.tsx,quote-view.tsx,appraisal-panel.tsx,settlement-model.ts,settlement-model.test.ts,settlement-panel.tsx}`, `apps/backoffice/test/buyback-render.test.mjs`, `apps/backoffice/src/api/messages.ts`, `apps/backoffice/package.json`, tài liệu này. Không thêm route riêng hoặc client API mới.

Kiểm tra frontend tuần tự: Backoffice `typecheck` PASS, ESLint PASS, Prettier trên file UI-B PASS, `test:buybacks` **19/19 PASS**, `git diff --check` PASS. Browser E2E và HTTP end-to-end có dữ liệu giao dịch: **NOT VERIFIED** do swap máy gần cạn và task cấm bật toàn bộ Docker cho browser E2E. Vì vậy Phase 7 UI chưa được gắn nhãn READY FOR DEMO end-to-end.
