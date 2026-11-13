# Tiến độ redesign Storefront — 10/11/2026

## Phạm vi và trạng thái

**READY FOR VISUAL REVIEW** — đã triển khai Storefront redesign lên Docker development, truy cập http://localhost:8081 .

Thiết kế lại trong `apps/storefront`: Home, Catalog, Product Detail, Cart, Checkout, guest Order Tracking, header/navigation/footer và các thành phần dùng chung. Trang tài khoản cũng nhận các token và form dùng chung. Không sửa Backoffice hoặc backend, Gateway, database, Prisma, RabbitMQ, Docker Compose. Không commit/push, reset/clean/restore.

## Thiết kế

Bảng màu ivory `#faf7f2`, espresso `#231914`, nâu `#81563d`, champagne/stone và viền ấm. Dùng Playfair Display cho tiêu đề và Be Vietnam Pro cho giao diện, đều qua Google Fonts đã có sẵn; có font fallback. Không thêm thư viện.

Container nội dung tối đa 1440px, gutter co giãn 20–72px; hero tối đa 1584px. Home có hero editorial hai cột với ảnh và liên kết sản phẩm lấy từ API thật, bộ sưu tập vàng/bạc có link lọc thật, 4 sản phẩm nổi bật có ảnh, danh mục lấy từ API và câu chuyện thương hiệu không chứa cam kết chưa xác minh. Không sao chép tài sản Emillia.

Catalog đạt 4 cột khi viewport từ 1400px, 3 cột tại desktop vừa, 2 cột tại tablet/mobile. Home 4/3/2 cột. Các form, summary, trang chi tiết và trạng thái loading/error/empty dùng cùng nền, màu, spacing và chữ lớn hơn. Tôn trọng reduced motion, focus rõ và alt ảnh sản phẩm. Giá/tên/tình trạng giữ nguyên từ API.

Đã mở được trang Dribbble tham khảo và đọc mô tả/palette, nhưng không xem được ảnh thiết kế chính; không tuyên bố đã đối chiếu trực quan mẫu. Tham khảo: https://dribbble.com/shots/27793219-Emillia-Fine-Jewelry-Luxury-Artisan-Web-Design .

## Nguyên nhân cảm giác nội dung nhỏ

Kiểm tra mã trước sửa: root 16px, container `min(1280px, calc(100% - 112px))`, catalog dành 230px cho sidebar cộng 45px gap rồi chia phần còn lại thành 3 cột. Nhiều thông tin ở 12–14px. Hero sử dụng vòng/hình khối CSS thay ảnh catalog. Không có CSS zoom hoặc transform scale thu nhỏ toàn trang; chỉ có scale 1.045 khi hover ảnh. Không có bằng chứng xác nhận browser zoom/device scaling của máy người dùng.

## File thay đổi trong task

- `apps/storefront/src/pages/home.tsx`: nội dung và bố cục trang chủ, chọn ảnh sản phẩm thật có liên kết đúng ID.
- `apps/storefront/src/components/layout.tsx`: navigation vàng/bạc và announcement.
- `apps/storefront/src/luxury.css`: lớp thiết kế có token, section, commerce và breakpoint; giữ stylesheet cũ làm nền cho cấu trúc trạng thái đã hoạt động.
- `apps/storefront/src/main.tsx`: nạp stylesheet mới sau stylesheet nền.
- `docs/storefront-redesign-progress.md` và ảnh chụp ở `docs/evidence/storefront-redesign-20261110/`.

Repository có nhiều thay đổi từ task trước. Các thay đổi backend/seed có sẵn không thuộc task redesign và không bị hoàn tác.

## Giữ nguyên nghiệp vụ

Không sửa API hooks, state giỏ, tính giá, persistence, CheckoutCoordinator/Vault, idempotency, reservation, quyền truy cập/token đơn hàng hoặc trạng thái xác nhận thanh toán. Không thêm gallery/trọng lượng giả khi API chưa cung cấp. Home đọc nhiều nhất 50 sản phẩm từ API để tìm ảnh thật, hiển thị 4 sản phẩm; cache 60 giây và error/retry hiện có. Các ảnh bộ sưu tập dùng để dẫn tới bộ lọc chất liệu, không thay ảnh của sản phẩm khác trong thẻ bán hàng.

## Kiểm thử

- TypeScript: PASS.
- ESLint: PASS.
- 40 Storefront tests: PASS, bao gồm lọc giá/biến thể, cart persistence, hết hàng, checkout double submission, idempotency, payment/tracking authorization và customer account.
- Production build Vite: PASS.
- Prettier và `git diff --check`: PASS.
- Browser Chromium với API thật: PASS ở 1440px, 1366px, 768px và 390px. Kiểm tra Home, Catalog, Product Detail, Cart, Checkout và guest Tracking không tràn ngang. Hero dùng hết chiều ngang viewport (1440/1366/768/390px tương ứng), body 16px.
- Thêm sản phẩm vào giỏ, reload vẫn giữ giỏ, tới form checkout thành công ở cả bốn viewport; mobile menu chuyển sang bộ lọc bạc thành công. Không submit đơn mới.
- Ảnh Home/Catalog/Product/Cart/Checkout và số đo nằm tại `docs/evidence/storefront-redesign-20261110/`; `results.json` ghi kết quả. Đã xem ảnh chụp Home desktop/mobile và Checkout desktop, sửa độ tương phản/footer links và tiêu đề collection mobile từ kết quả visual review.
- Trạng thái empty/error/loading được giữ component cũ và tests; chưa ép lỗi mạng trên browser trong lần này, nên các trạng thái lỗi mạng trực quan: NOT VERIFIED.

## Hạn chế

Chất lượng và độ phân giải ảnh phụ thuộc nguồn catalog đã seed; tên demo/giá demo được giữ nguyên. Google Fonts cần mạng và có fallback. Không tạo thanh toán/đơn mới trong kiểm thử giao diện này; regression nghiệp vụ được bao phủ bởi tests hiện có, browser chỉ đi đến form checkout. Bản preview ban đầu chạy ở http://localhost:5174; đợt deploy riêng bên dưới đã đưa bản redesign lên Docker port 8081.

## Deploy Docker development — 10/11/2026

- Branch giữ nguyên `feat/sales-pos`; repository có sẵn nhiều thay đổi chưa commit. Không chuyển branch hoặc commit/push.
- Đọc labels của container để xác nhận Compose thực tế là `docker-compose.yml` + `docker-compose.override.yml`, project `jewelry`. Không dùng file Compose khác.
- Service `storefront`, image `jewelry/storefront:dev`, Dockerfile `apps/storefront/Dockerfile`, build context root repository. Nginx cổng 8080, host cổng **8081**. Network giữ IP `172.30.0.17`.
- Docker Engine 29.9.2 hoạt động; auth/inventory/sales/report vẫn dùng đúng bốn host PostgreSQL và bốn database độc lập. Container PostgreSQL legacy có sẵn được giữ nguyên.
- Build riêng Storefront: **PASS**. Recreate bằng `up -d --no-deps --force-recreate storefront`: **PASS**, container running/healthy. Không rebuild/restart backend hoặc dependencies. Cả 12 container khác giữ nguyên ID và StartedAt so với trước deploy.
- Image mới `sha256:7840ca1999f457c049ad4f8a878226ba61af2c29cfaee3a15c994058760e8f84`. Bundle CSS có token ivory và `.hero-product`; JavaScript có nội dung redesign. SHA-256 assets tải qua HTTP khớp file trong container.
- HTTP home, các SPA route, CSS và JavaScript: **PASS**. Catalog API trả 33 sản phẩm và API chi tiết hoạt động. Trình duyệt gọi `/api/` cùng origin, Nginx proxy tới `http://gateway:3000`; không gọi localhost bên trong container.
- Không phát hiện lỗi cần sửa source hoặc cấu hình deploy. Docker socket và Chromium cần quyền ngoài sandbox để kiểm thử; đã được phép chạy. Không sửa backend/database/Compose, không migration, không xóa volumes.
- Không tạo đơn hoặc thanh toán mới trong smoke test.
- Bằng chứng: `docs/evidence/storefront-docker-redesign-20261110/` gồm build log, cấu hình service đã lọc, ID container trước deploy và kết quả HTTP/assets/Gateway.

- Browser trên container thật tại `http://localhost:8081`: **PASS** tại 1440/1366/768/390px. Hero tải ảnh, home/catalog/product/cart/checkout/guest tracking không tràn ngang; thêm vào giỏ, reload giữ giỏ, mở form checkout và mobile menu lọc bạc đều đạt. Ảnh desktop/mobile và `results.json` nằm trong thư mục bằng chứng deploy nêu trên. Đã xem ảnh Home Docker desktop để xác nhận phong cách mới.
- RAM cuối đợt kiểm tra: khả dụng **3872 MiB (~3,8 GiB)**; swap còn **1440 MiB (~1,4 GiB)**.
- File thay đổi trong đợt deploy: chỉ báo cáo này và các file bằng chứng mới; không sửa source/config ứng dụng. `git diff --check`: PASS.

## Sửa điều hướng chất liệu — 10/11/2026

URL và API đã lọc theo `metalKind`, nhưng tiêu đề/breadcrumb luôn giống trang tổng và NavLink Bộ sưu tập chỉ xét pathname, nên vẫn báo active khi chọn vàng/bạc. Layout cũng chưa phản ứng khi chỉ query thay đổi.

Sửa riêng frontend: tiêu đề, breadcrumb và document title theo chất liệu; `aria-current` và gạch chân/màu menu đúng query; layout phản ứng khi đổi query để đóng menu, focus và cuộn về đầu trang. Không sửa backend hoặc cách tính giá/lọc tồn kho. Bộ lọc hiện đã remount theo query, giữ nguyên cơ chế đó.

41 Storefront tests PASS (thêm regression cho tiêu đề và menu theo chất liệu), typecheck/lint PASS; build và recreate riêng Storefront tại http://localhost:8081 thành công. Bằng chứng browser lưu ở `docs/evidence/catalog-navigation-20261110/`.

Browser bản Docker cuối: PASS tại desktop 1440px và mobile 390px với chuỗi Tất cả → Vàng → Bạc → Vàng → Tất cả, rồi Back. Tiêu đề, menu active và radio đúng query; API trả 13 sản phẩm vàng, 20 bạc, 33 tất cả. Ảnh và `results.json` được lưu kèm.
