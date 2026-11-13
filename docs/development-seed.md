# Seed development toàn hệ thống

Đã seed dữ liệu mẫu vào project Docker `jewelry` ngày 2026-11-10.
Không reset database, xoá volume hoặc xoá dữ liệu cũ. Namespace riêng: `DEMO26`.

## Truy cập

- Backoffice: http://localhost:8080/
- Storefront: http://localhost:8081/bo-suu-tap
- Đơn hàng tài khoản: http://localhost:8081/tai-khoan/don-hang
- Guest: http://localhost:8081/don-hang/khach

**Chọn cơ sở có `(Demo)`** trong Backoffice để thấy dữ liệu mới; cơ sở cũ vẫn được giữ.

Tài khoản/mật khẩu được sinh ngẫu nhiên và lưu riêng tại:

```text
secrets/demo-seed/accounts.txt
secrets/demo-seed/manifest.json
```

Các file này bị loại khỏi Git và Docker build context. File có quyền 600, thư mục có quyền 700.
Không đưa mật khẩu/token/capability vào tài liệu hoặc evidence công khai.

- Admin: `admin.demo@example.test` — đăng nhập bằng email và mật khẩu trong accounts.txt.
- Người kiểm soát riêng: `reviewer.demo@example.test` — ADMIN thứ hai, dùng kiểm duyệt thu mua/chi tiền.
- Quản lý Google: `23010085@st.phenikaa-uni.edu.vn` — MANAGER của ba chi nhánh demo.
  Quyền STAFF tại cơ sở cũ được giữ lại. Đăng nhập Google theo cơ chế hiện có; chọn cơ sở Demo để thao tác.
- Ba nhân viên demo có email `staff.hn.demo@example.test`, `staff.hcm.demo@example.test`,
  `staff.dn.demo@example.test`. Đây là hồ sơ mẫu; cần gán/tạo tài khoản với email Google thật để đăng nhập.
  Không tạo mật khẩu nhân viên, không giả mạo Google identity hoặc nới quyền xác thực.
- Khách Storefront: `khach.a.demo@example.test`, `khach.b.demo@example.test`, `khach.c.demo@example.test`.
  Mật khẩu trong accounts.txt. Khách C chưa có đơn để kiểm empty state.

## Dữ liệu được tạo

| Phần | Dữ liệu seed |
| --- | --- |
| Chi nhánh | DEMO26-HN, DEMO26-HCM, DEMO26-DN; kho tạo qua sự kiện branch.created |
| Kim loại | Vàng 9999, vàng 18K, vàng 14K, bạc 925; giá mua/bán minh hoạ |
| Danh mục | Nhẫn, dây chuyền, lắc tay, có nhãn Demo |
| Sản phẩm online | 6 sản phẩm / 6 biến thể, SKU bắt đầu DEMO26 |
| Nhập hàng | 3 phiếu APPROVED, mỗi phiếu 36 chiếc; 108 chiếc theo tem riêng |
| Online stock | 3 kho demo bật nhận đơn; buffer 1 chiếc/biến thể/kho |
| Khách POS | 6 hồ sơ mẫu với số điện thoại giả lập |
| Đơn POS | 9: mỗi chi nhánh 1 COMPLETED, 1 CANCELLED, 1 PENDING_PAYMENT |
| Khách Storefront | 3 tài khoản độc lập với khách POS |
| Đơn online | A: 1 CONFIRMED + 1 AWAITING_PAYMENT; B: 1 CANCELLED; guest: 1 AWAITING_PAYMENT |
| Thu mua | 6 hồ sơ: nháp, chờ kiểm định, đã kiểm định, đã duyệt kèm settlement SETTLED, từ chối và huỷ |
| Chính sách thu mua | Một policy vàng 9999 cho mỗi chi nhánh demo |
| Báo cáo | Sự kiện của 3 đơn POS trả tiền và một giao dịch thu mua/nhập tài sản đã được xử lý qua RabbitMQ |

Sản phẩm: nhẫn trơn vàng 9999, nhẫn hoa vàng 18K, dây chuyền vàng 18K, lắc tay vàng 14K,
nhẫn bạc 925 tối giản và lắc tay bạc 925. Giá chỉ là ví dụ để thử nghiệp vụ, không phải báo giá thị trường.

Mã tem ví dụ: `DEMO26-HN-NHAN24-02`. Dùng tem còn IN_STOCK trong trang Tồn kho để thử bán.
Tem đuôi `01` của một số biến thể đã được dùng cho các hoá đơn mẫu; không tự trả hàng đã bán về kho khi chạy lại seed.

Luồng thu mua hoàn tất tạo thêm một chiếc/tài sản BOUGHT_BACK và các bản ghi kho liên quan qua handler hiện có;
không đưa tài sản đang chờ xử lý lại thành sản phẩm online giả.

## Cách chạy lại

```bash
pnpm seed:dev

# Khi khởi tạo dataset ở môi trường development khác:
SEED_MANAGER_EMAIL=your-google-email@example.com pnpm seed:dev

# Chỉ xem quy mô dự kiến, chưa kết nối/chỉnh dữ liệu:
node scripts/seed-development.mjs --plan
```

Script: `scripts/seed-development.mjs`. Chạy trên host có Docker CLI và các container development đang healthy.
Kiểm project/database đích trước khi viết. Tự sao lưu bốn database khi khởi tạo manifest lần đầu.
Backup lần seed này nằm tại `secrets/backups/system-seed-1794300719847/`; cả bốn dump đã kiểm đọc được bằng pg_restore.
Không thực hiện restore đè lên dữ liệu đang chạy.

Script ghi qua API của service. Chỉ bootstrap ADMIN bằng CLI Auth có sẵn.
SQL trong script chỉ đọc dữ liệu để kiểm tra/synchronization; không ghi trực tiếp hoặc ghép FK xuyên database.
Nhập hàng do ADMIN tạo/duyệt; giá, tổng tiền, trạng thái đơn và báo cáo do backend tính/phát sự kiện.

Manifest giữ ID, key chống trùng và capability guest. Script tìm lại entity theo mã riêng và dùng API idempotency
cho đơn/giao dịch. Đã chạy lại và đối chiếu số dòng các bảng chính, không tăng thêm bản ghi dữ liệu.
Không xoá manifest nếu muốn chạy lại cùng bộ seed; không dùng script để reset trạng thái hoặc bù hàng đã bán.

## Kiểm chứng

- Script đã chạy hoàn tất qua Auth → Inventory/Sales → RabbitMQ → Report.
- Mọi database được sao lưu trước khi seed, dữ liệu cũ không bị reset hoặc xoá.
- Tài khoản quản lý ACTIVE, giữ assignment cũ và có MANAGER ở ba chi nhánh demo.
- Xác nhận Storefront trả 6 sản phẩm có tồn online, khách A xem đúng hai đơn và khách C nhận danh sách rỗng.
- Đối chiếu Report OrderRevenue có PAID cho cả ba đơn POS hoàn tất.
- Đối chiếu cả BuybackSettlementFact và BuybackStockFact cho settlement thu mua mẫu.
- Seed chạy lại không tạo trùng entity trên các bảng đã đối chiếu.
- Chromium kiểm đăng nhập admin, phiếu nhập đúng cơ sở Hà Nội demo, catalogue Storefront,
  đăng nhập khách A và hai đơn thật từ API.
- ESLint, Prettier và Node syntax check của script qua; không đổi runtime code hoặc schema ứng dụng.

Bằng chứng giao diện: [browser results](evidence/development-seed-20261110/browser-results.json),
[catalogue](evidence/development-seed-20261110/storefront-catalog.png),
[đơn khách A](evidence/development-seed-20261110/customer-orders.png),
[phiếu nhập admin](evidence/development-seed-20261110/backoffice-receipts.png).

## Giới hạn và lưu ý dữ liệu mẫu

- Giao dịch nhận/chuyển tiền mẫu có reference/evidence `DEMO26`/`DEMO ONLY`, không có chuyển tiền ngân hàng thực.
  Không cấu hình tài khoản ngân hàng hoặc QR giả.
- Dữ liệu doanh thu/thu mua mẫu có mặt trong báo cáo development. Đây là dữ liệu demo có chủ đích, không phải doanh thu thực.
- Đơn online chưa trả tiền tự hết hạn theo TTL 30 phút; đơn CONFIRMED vẫn tuân thủ thời gian giữ hàng đã trả tiền hiện có.
  Chạy lại seed giữ lịch sử cũ, không tạo đơn thay thế chỉ để phục hồi trạng thái chờ.
- Không giả lập snapshot chốt kho quá khứ hoặc gọi chốt ngày trước giờ để làm đầy biểu đồ.
  Report tồn đầu/cuối ngày sẽ có theo lịch chốt thực (worker chốt từ 00:05 giờ Việt Nam).
- Không tự ghép khách POS/guest với tài khoản Storefront theo số điện thoại hoặc email.
- Nhân viên demo vẫn không được nhập hàng; chỉ ADMIN có menu/API phiếu nhập.
