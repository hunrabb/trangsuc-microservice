# Deploy Stock Summary — Docker development

Ngày: 10/11/2026, Việt Nam. Repository thực tế: trangsuc-microservice.

## Triển khai

Compose: docker-compose.yml + docker-compose.override.yml, project jewelry, bốn PostgreSQL riêng cho Auth/Inventory/Sales/Report. Container postgres legacy đã chạy sẵn, giữ nguyên. Gateway đã chuyển /api/admin/inventory/* sang Inventory /admin/* nên không sửa/rebuild Gateway.

Build Inventory rồi Backoffice, recreate bằng:

```bash
docker compose build inventory
docker compose build backoffice
docker compose up -d --no-deps --force-recreate --wait inventory backoffice
```

Chỉ ID container inventory và backoffice thay đổi khi so sánh toàn bộ danh sách trước/sau. Cả hai healthy.

| Container | Image | ID image mới |
| --- | --- | --- |
| jewelry-inventory-1 | jewelry/inventory:dev | sha256:b60fb9329a8b7d4e95a4cea6d6eecf7488c0f65ce5bbb366393f55275e52e85d |
| jewelry-backoffice-1 | jewelry/backoffice:dev | sha256:421a1ede22db932f5ade00d4cef95d396f2fd7a5a9fb8820184571df2f375ebe |

Không sửa source nghiệp vụ trong lượt deploy này; giữ thay đổi có sẵn. Không chạy migration, sửa database/schema, recreate PostgreSQL/RabbitMQ, xoá volume, tiếp tục chuyển public hoặc commit/push.

URL: http://localhost:8080/ton-kho (cần đăng nhập).

## API thật

PASS qua Gateway http://localhost:3000/api/admin/inventory/items/summary.

- ADMIN xem chi nhánh chọn: 200; MANAGER/STAFF có claim chi nhánh: 200.
- MANAGER/STAFF yêu cầu chi nhánh khác ngoài claim: 403. Request không token: 401.
- Đọc đủ các trang summary, đối chiếu kết quả SQL từ PostgreSQL hiện hành và đếm trực tiếp JewelryItem theo trạng thái: khớp.
- Chi nhánh được kiểm tra có 34 biến thể, 91 chiếc: IN_STOCK 88, SOLD 2, PENDING_MELT 1. Không đồng nhất IN_STOCK thô với khả dụng khi hàng ngừng bán/chưa có giá.
- Tổng các nhóm bằng total; sold/pendingMelt khớp truy vấn trực tiếp. Dữ liệu live không có RESERVED; xác nhận số giữ bằng 0, chưa kiểm chứng live trường hợp >0. Các trường hợp reservation có hiệu lực/hết hạn đã test riêng trên bảng tạm ở task triển khai.
- API danh sách mã tem và API dữ liệu in tem: 200.

Quyền được kiểm tra bằng JWT RS256 kiểm thử ngắn hạn dùng khoá development hiện có; không tạo user/refresh token hoặc chỉnh phân quyền database. Đây là kiểm tra guard theo claims, không kiểm tra luồng đăng nhập hay cấp quyền mới.

## Browser desktop

PASS bằng Chromium headless viewport 1440×1000:

- Trang /ton-kho lấy dữ liệu từ container Backoffice mới và API Inventory qua Gateway.
- Sáu cột số lượng của dòng mẫu khớp dữ liệu API.
- Nút Xem mã tem gửi đúng variantId và branchId; response chỉ có chiếc thuộc phạm vi đó.
- Chuyển qua lại Theo mẫu / biến thể và Theo mã tem hoạt động.
- Link In tem mở popup có đúng mã tem và nội dung tem. Không in vật lý.
- Không có pageerror JavaScript.

Chỉ bước bootstrap phiên /api/auth/refresh được harness cung cấp JWT kiểm thử; /me, chi nhánh, danh mục, summary, items và label đều dùng API thật. Chưa kiểm tra đăng nhập bằng mật khẩu/Google trong browser hoặc browser dưới từng role; kiểm tra role thực hiện ở API.

Chromium ban đầu thiếu libnspr4/libnss3/libasound; tải và giải nén thư viện vào /tmp, không cài hay sửa hệ điều hành. Lần assert nội dung popup đầu đọc quá sớm; sửa harness chờ mã tem render rồi PASS, không sửa source ứng dụng. Không phát hiện lỗi ứng dụng cần sửa. Build có cảnh báo bundle Backoffice lớn đã có, không làm build thất bại.

## Tài nguyên và bằng chứng

Trước build RAM available ~4243 MiB, swap dùng 0/2048 MiB. Sau deploy/browser RAM available ~4186 MiB, swap dùng 0. Trong build RAM available vẫn >3,7 GiB, không có dấu hiệu thiếu tài nguyên cần dừng.

Logs: /tmp/stock-summary-deploy-inventory.log, /tmp/stock-summary-deploy-backoffice.log, /tmp/stock-summary-recreate.log, /tmp/stock-summary-live-results.log, /tmp/stock-summary-browser-results.log.

Ảnh desktop: /tmp/stock-summary-desktop.png, /tmp/stock-summary-tags.png, /tmp/stock-summary-label.png. Script kiểm tra chỉ nằm trong /tmp; token không in vào báo cáo hoặc log.
