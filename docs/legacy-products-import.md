# Nhập danh mục Laragon vào Docker development

Lệnh: `pnpm seed:legacy-products`. Cần seed nền `pnpm seed:dev` trước để có admin, bảng giá và ba chi nhánh demo. Script dùng tài khoản trong `secrets/demo-seed/manifest.json`, chỉ ghi qua API; không sửa database Laragon, không reset database hoặc volumes.

## Nguồn và cách chuyển đổi

- `C:\laragon\www\managerCourse`: database `maneger-course` có 0 sản phẩm; không nhập những ảnh rời vì không có bản ghi sản phẩm tương ứng.
- `C:\laragon\www\laravel-admin`: đọc 14 bản ghi từ `vangbac.sanpham`, danh mục từ `loai_san_phams`, ảnh từ `storage/app/public/products`.
- `C:\laragon\www\frontend-html`: lấy thẻ sản phẩm trong HTML, đối chiếu ảnh ở `img/public/store`, sửa liên kết viết sai `nhân nữ` thành `nhẫn nữ` khi file tồn tại. Loại thẻ lặp theo nội dung ảnh: còn 13 mẫu, không nhân bản các trang danh mục có cùng nội dung.

Snapshot đã chuẩn hóa ở `scripts/data/legacy-products.json`. Ảnh được sao chép nguyên bản vào `apps/storefront/public/catalog-images`, đặt tên theo SHA-256. Không dùng ảnh ngoài danh mục sản phẩm. Backend chấp nhận thêm đường ảnh nội bộ đúng mẫu `/catalog-images/<64 ký tự hex>.(jpg|jpeg|png|webp)`; quy tắc HTTPS cũ vẫn được hỗ trợ.

Đây là **dữ liệu demo**, không phải chuyển kho kế toán từ hệ thống cũ:

- Giữ tên, danh mục, trọng lượng, công và tiền đá của 14 bản ghi nguồn; tên có thêm số mẫu để phân biệt. Nguồn có tên thử nghiệm và tên/ảnh không luôn khớp; không tự sửa thành thông tin khẳng định khác.
- Kim loại nguồn 1 dùng vàng 9999 demo, nguồn 2 dùng bạc 925 demo. Bản ghi thiếu kim loại dùng vàng 9999 demo và ghi rõ giả định trong mô tả.
- HTML không có trọng lượng/chất liệu: dùng bạc 925 demo, 1 chỉ, công 180.000 đồng; mô tả ghi rõ và lưu giá hiển thị cũ để đối chiếu.
- Dùng bảng giá kim loại **DEMO26** sẵn có; không đưa giá bạc bất thường trong nguồn vào bảng giá hiện tại. Công và tiền đá được cộng vào công chế tác do hệ thống hiện chưa có giá đá riêng.
- Mỗi mẫu có 1 SKU `LAR26-*`, nhận 2 món tại mỗi chi nhánh demo HN/HCM/DN qua phiếu nhập ADMIN: tổng 162 món. Giá vốn là giá mua demo × trọng lượng + công/đá. Không giả định đây là tồn hay giá vốn thật của nguồn.
- Buffer online 1 món/biến thể/kho. Chỉ thay cấu hình cho biến thể mới tại ba kho demo.

## Chạy lại và phục hồi

Trước lần ghi đầu tiên, script kiểm tra đúng Docker project `jewelry`, bốn service healthy và database development riêng từng service. Tạo bốn bản sao `pg_dump -Fc` và kiểm tra đọc được bằng `pg_restore --list`. Đường dẫn backup và ID bản ghi lưu riêng trong `secrets/manager-course-import/manifest.json` (không commit).

Chạy lại nhận diện sản phẩm và SKU, tiếp tục phiếu nháp bằng tem duy nhất; phiếu đã duyệt không tạo lại. Không cấp bù hàng đã bán, không xóa hàng cũ. Nếu có lỗi API, script dừng, không tự retry POST. Chỉ chạy một tiến trình import tại một thời điểm.

Xác minh sau nhập: đủ 27 sản phẩm trên API công khai, tất cả còn hàng, từng URL ảnh trả HTTP 200 với Content-Type ảnh. Kiểm thử trình duyệt kiểm tra ảnh tải được và trang chi tiết/giỏ hàng.

## Kết quả thực tế ngày 10/11/2026

- Import 27 mẫu (14 database + 13 HTML), 27 biến thể, 3 phiếu nhập đã duyệt, 162 món.
- 27/27 mẫu còn hàng trên Storefront; 27/27 URL ảnh trả HTTP 200 và đúng Content-Type.
- Trình duyệt Chromium: đủ 27 thẻ qua 3 trang, mọi ảnh tải được; mở chi tiết và thêm vào giỏ thành công cho cả hai nguồn. Ảnh và kết quả ở `docs/evidence/legacy-products-import-20261110/`.
- Chạy lại seed: số Product, ProductVariant, GoodsReceipt, GoodsReceiptLine và JewelryItem giữ nguyên.
- Storefront: 40 kiểm thử đạt; Inventory catalog: 7 kiểm thử đạt, gồm giới hạn đường ảnh nội bộ.
- Rebuild/recreate Inventory và Storefront; cả 13 container hiện healthy. Không migration, reset database hoặc xóa volume.
- Truy cập: http://localhost:8081/bo-suu-tap ; backoffice http://localhost:8080/nhap-hang .
