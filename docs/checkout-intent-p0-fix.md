# P0: Checkout bị lịch sử đơn cũ chiếm form — 10/11/2026

## Tái hiện trước khi sửa

Thực hiện trên container cũ tại `http://localhost:8081`, đúng chuỗi: đặt A → hủy A → Catalog → thêm sản phẩm → Giỏ → Tiếp tục đặt hàng → `/dat-hang` → bấm **Đặt đơn mới từ giỏ hàng** → submit.

- POST thứ nhất HTTP 202, key test `e3d8fd1b…`, Order ID `27b7917d…`.
- Vào `/dat-hang` lần hai, **chưa submit** và chưa có POST thứ hai, form đã bị thay bằng “Yêu cầu trước đã kết thúc”. Session activeId trỏ attempt có orderId của A, lastStatus CANCELLED.
- Bấm nút Đặt đơn mới xóa activeId, form mới mở. Submit gửi key mới `d6ccda50…` và backend trả Order ID mới `d7d3d5c0…`, HTTP 202. Không có bằng chứng backend dùng lại key cũ trong đường đi này.
- Tái hiện còn phát hiện tình huống riêng: thêm lại cùng sản phẩm làm số lượng tăng từ 1 lên 2. Đơn mới bị `ITEM_NOT_AVAILABLE` do tồn khả dụng theo kho/buffer, không phải EXPIRED hoặc đơn cũ. Giữ kiểm tra tồn kho backend, không giả vờ mua thành công. Bộ A–H dùng sản phẩm demo có đủ tồn để mua lại, không mock catalog.

Trace trước sửa: `docs/evidence/checkout-intent-p0-20261110/before.json`. Không lưu token/địa chỉ khách vào evidence.

## Root cause và vì sao lần trước bỏ sót

Sửa `known()` trước đó chỉ ngăn callback tracking chọn lại một attempt cũ. Nhưng `CheckoutVault.active()` vẫn trả attempt đã có Order ID nếu activeId trỏ vào nó; CheckoutPage dùng mọi active attempt để chặn form và GET trạng thái đơn trước.

Test A–E trước dùng nút **Quay lại giỏ để đặt một đơn khác** từ tracking. Nút đó gọi startNew() nên xóa activeId. Đi qua Catalog/header không gọi startNew(), khiến thiết kế cũ vẫn coi lịch sử là checkout hiện hành. Vì thế test PASS không chứng minh đường Catalog của người dùng đã được sửa.

## State machine mới

- **Chưa gửi:** giỏ/draft form, chưa có key hoặc POST. Mở/refresh `/dat-hang` không gửi đơn.
- **Đã gửi nhưng chưa biết kết quả:** orderId null, giữ token/key/body gốc và quyền phục hồi. Chặn checkout khác; retry/recover cùng key. Không bỏ trạng thái này chỉ vì đi Catalog hoặc giỏ thay đổi.
- **Đã biết Order ID:** chuyển sang tracking/history ngay, không còn chiếm form của lần mua mới. Không phụ thuộc đơn cũ CANCELLED, CONFIRMED hay đang chờ thanh toán.
- Lượt mua mới tạo token/key ở lúc submit, không tạo khi chỉ mở trang.
- Callback lịch sử chỉ cập nhật bản ghi hiện có, không chọn lại intent và không phục hồi credentials đã quên/hết hạn. Nếu đang có request chưa biết kết quả khác, callback cũ không xóa intent đó.
- Constructor đọc session v1 cũ và bỏ activeId nếu nó chỉ trỏ vào đơn đã biết ID. Giữ lịch sử, không xóa localStorage/sessionStorage.
- Giỏ trống hiển thị đúng empty state; hàng không khả dụng vẫn theo kiểm tra sản phẩm/submit backend hiện có.

## File thay đổi

- `apps/storefront/src/state/checkout.ts`: active chỉ đại diện unresolved submission, known chuyển sang history; tương thích session đã lưu.
- `apps/storefront/src/pages/checkout.tsx`: bỏ GET/gate trạng thái đơn đã biết và nút bắt đầu lại thừa. Form giỏ bình thường hoặc recovery cho request chưa rõ kết quả.
- `apps/storefront/test/storefront.test.mjs`: cập nhật invariant cũ, thêm kiểm tra legacy session, trạng thái đơn lịch sử, form và giỏ trống; giữ timeout/retry/double-submit tests.
- `apps/storefront/test/checkout-intent.browser.mjs`: browser integration A–H, opt-in `RUN_REBUY_DEVELOPMENT=1`; dùng Playwright đã cài ngoài repo, không thêm dependency runtime.
- `apps/storefront/test/rebuy.integration.mjs`: cập nhật expectation lịch sử không chặn form theo state machine mới.
- Báo cáo và các file evidence. Không sửa backend, Prisma, migration, RabbitMQ, Compose hoặc dữ liệu đơn của người dùng.

## Kiểm thử browser trên Docker mới

| Case | Kết quả | Xác minh |
|---|---|---|
| A | PASS | Hủy A → Catalog → thêm hàng → Checkout thấy form ngay, không banner/nút đặt lại. Session v1 cũ cũng mở form. |
| B | PASS | Đơn test hết hạn qua worker thật → Catalog/thêm hàng → form mới. |
| C | PASS | Refresh lúc đang nhập vẫn là form mới, không có POST ngầm. Không bổ sung lưu PII draft vào storage. |
| D | PASS | Submit nhận Order ID và key mới, URL khớp response; backend AWAITING_PAYMENT, card demo hiển thị. |
| E | PASS | Browser Back/Forward không đưa đơn cũ trở lại checkout. |
| F | PASS | Giữ response GET tracking thật đến khi form mới đã mở rồi mới thả; form/activeId không bị chiếm lại. Navigation có thể hủy caller cũ; regression unit cũng gọi known callback trễ trực tiếp. |
| G | PASS | Bỏ hàng bằng UI rồi mở thẳng `/dat-hang`: hiển thị giỏ trống, không lấy trạng thái đơn cũ thay thế. |
| H | PASS | Mở lại đơn cũ trong lịch sử vẫn xem được; quay checkout vẫn là form mới. |

Chi tiết: `apps/storefront/test/evidence/checkout-intent-p0/results.json` và `new-payment.png`.

Expiry case B chỉ đưa thời hạn của đúng **đơn test mới có marker `P0 checkout integration DEMO`** về quá khứ để worker đang chạy xử lý. Không thay đồng hồ hoặc TTL, không sửa đơn phát triển của người dùng. Đơn thử còn chờ được hủy qua API và SQL xác nhận RELEASED/EXPIRED.

## Deployment và kiểm chứng

- Chỉ build/recreate `storefront` bằng `docker-compose.yml` + `docker-compose.override.yml`, `--no-deps`.
- Image: `sha256:079e08317192582eb1558d77f152f814e478d98544b72cfaf4acd8852059bc57`.
- Container: `b42785ccfbd28301e9052c8b785eeb58b6669a48d1b5cb1e3926bd87482cc340`, running/healthy; URL **http://localhost:8081**.
- Browser tải `/assets/index-3I8mn11e.js` HTTP 200. SHA-256 JS/CSS qua HTTP khớp file container và build source. Không có service worker trong browser context, không ghi nhận uncaught runtime errors.
- Đúng 3 POST checkout ứng với 3 lần submit chủ đích trong bộ A–H; không có POST khi mở form, refresh, Back/Forward hoặc mở lịch sử.
- Order đầu `91b62599…`, mua lại sau hủy `78bc979c…`, mua lại sau expiry và callback trễ `2c03f59a…`. Key lần lượt `5958f405…`, `4d86084c…`, `0f6dbe9e…`. SQL đối chiếu tại `docs/evidence/checkout-intent-p0-20261110/`.
- 47 frontend tests PASS; typecheck, lint, Prettier, production build và git diff --check PASS.

## Giới hạn kiểm chứng

Chạy Chromium automation trên Docker thật, không điều khiển trực tiếp profile Chrome/Windows của người dùng. Case expiry được tăng tốc bằng thời hạn của riêng đơn test, không chờ 30 phút ngoài đời. Chưa chạy toàn bộ A–H trên nhiều tab/máy hoặc nhiều tài khoản đồng thời. Không xác nhận thanh toán thật. Các giới hạn này không được tính thành PASS.
