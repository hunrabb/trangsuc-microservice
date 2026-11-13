# Lỗi checkout lại trả về đơn cũ — 10/11/2026

## Nguyên nhân được tái hiện trước khi sửa

Tái hiện trên Docker 8081, dùng dữ liệu demo: POST checkout trả HTTP 202, order `fec65a6b-54af-4dd7-86f3-73b71dbe5450`, test key `54038705-7cd8-480d-96cb-ce5fd62d3443`; URL tracking đúng ID. Sau hủy và bấm **Quay lại giỏ để đặt một đơn khác**, sessionStorage vẫn có activeId của attempt cũ. Vào checkout lại vẫn bị chặn bởi đơn cũ, chưa có POST thứ hai. SQL: đơn CANCELLED, reservation `1a604741…` RELEASED. Bằng chứng ở `docs/evidence/checkout-rebuy-20261110/`.

`CheckoutVault.known()` dùng `save()`, trong khi `save()` luôn đặt activeId thành ID attempt đang lưu. Tracking gọi known trong effect để đồng bộ mỗi response. Effect chạy trễ sau startNew hoặc khi xem lịch sử có thể kích hoạt lại attempt cũ, ghi đè lựa chọn checkout mới. Đây là lỗi frontend vòng đời intent, không phải TTL bị rút ngắn hay backend bỏ qua key mới.

Lần kiểm thử trước chỉ mở lại form, chưa submit giao dịch mua thứ hai và chưa bao phủ đường “Quay lại giỏ” từ tracking. Lần này thực hiện đầy đủ hai lần mua và đối chiếu SQL.

## Sửa đúng nguồn gây lỗi

- `apps/storefront/src/state/checkout.ts`: save có tùy chọn activate; prepare/import vẫn kích hoạt như trước. known chỉ cập nhật thông tin attempt đã tồn tại, không đổi activeId, không phục hồi credential bị quên/hết hạn. Dùng bản stored hiện tại thay vì snapshot cũ khi cập nhật.
- Không thay token/key đã cấp cho retry, không thay backend idempotency. startNew vẫn từ chối khi có attempt chưa biết kết quả.
- Giữ nguyên cart/localStorage; checkout intent/capability vẫn lưu sessionStorage. Điều hướng success vẫn lấy ID từ response của POST/recover.
- Không sửa backend, Prisma/migration, worker, TTL, dữ liệu thật hoặc schema public.

## Kiểm tra A–E bằng API/database thật

Script tái chạy: `apps/storefront/test/rebuy.integration.mjs`, cần Playwright và quyền Docker. Cờ `RUN_REBUY_DEVELOPMENT=1` xác nhận chỉ chạy trên local development. Có thể chỉ định `PLAYWRIGHT_MODULE` là đường dẫn module đã cài, `TEST_BASE=http://localhost:8081`.

- A: gửi lại POST với cùng token/key/body, HTTP 202, cùng order ID.
- B: hủy đơn 1, nút tracking quay lại giỏ, submit mua mới: key/token và order ID mới; trạng thái AWAITING_PAYMENT.
- C: refresh tracking mới, mở lịch sử đơn cũ, quay checkout và refresh: vẫn giữ đơn mới hiện hành.
- D: chủ động làm mất response sau khi backend đã tạo đơn. UI giữ intent chưa biết kết quả qua reload; bấm retry cùng request trả đúng ID/key cũ, không tạo key mới.
- E: chỉ đưa deadline/expiresAt của **đơn test vừa tạo, có marker Rebuy integration DEMO** về quá khứ. Worker thật chuyển reservation EXPIRED/đơn CANCELLED. Mua lại tạo order, key, reservation và deadline mới; SQL kiểm tra không có một món vật lý bị giữ bởi nhiều reservation active. Không chỉnh đồng hồ hệ thống, không đổi TTL, không sửa đơn của người dùng.

Script giữ credentials test trong secrets/rebuy-audit (gitignored), chỉ xuất test key và metadata vào evidence. Sau test hủy các đơn còn chờ qua API; nếu rate limit 429, chờ cửa sổ rồi dọn, không đổi rule hoặc xóa dữ liệu.

Các integration suite SQL cũ yêu cầu database *_test riêng. Môi trường hiện không có database đó; không tự tạo/migrate. Thay bằng script A–E ở trên chạy API thật + SQL trên dữ liệu demo được kiểm soát.

## Kết quả sau deploy Docker

- Storefront image build PASS; chỉ recreate service storefront. Container healthy, URL http://localhost:8081 .
- Typecheck, ESLint, Prettier, production build và git diff --check PASS; 46 frontend tests PASS (thêm regression tracking cập nhật trễ sau startNew, lịch sử ghi đè intent mới, credential đã quên).
- Integration A–E trên Docker: **PASS**, file `apps/storefront/test/evidence/rebuy/results.json`. Có screenshot màn hình thanh toán demo của đơn mới.
- A: key `3e8d6045…`, retry cùng request trả cùng order `6d06fdbc…`, HTTP 202.
- B: sau hủy, POST lần mua mới key `bbcb1845…` trả order `0aff4484…`, HTTP 202; URL frontend khớp response. Sau xử lý reservation, backend AWAITING_PAYMENT.
- C: refresh và xem lại lịch sử không thay active order mới.
- E: worker thật hết hạn reservation `ffb197bf…` của order `0aff4484…`; mua tiếp key `679c798f…` trả order `3ba9e269…` với reservation `7e06bee9…`, deadline mới. Trạng thái AWAITING_PAYMENT và card demo hiển thị. SQL không thấy một jewelry item nào bị giữ bởi nhiều reservation active.
- D: POST đã tạo order `fab37fdf…` nhưng response bị chủ động ngắt. Qua reload, retry vẫn dùng key `27e0dfc3…` và nhận đúng order `fab37fdf…`.
- Đã hủy toàn bộ đơn thử còn chờ bằng API. Một lần cleanup trước đó gặp giới hạn 10 POST/phút, đã chờ và hủy lại thành công; không sửa rate limit.
- Không có thay đổi backend, migration hoặc dữ liệu người dùng; chỉ cập nhật expiry của đúng đơn test nhằm chạy case E. Không reset DB/volumes.

File thay đổi trong lần sửa này: `apps/storefront/src/state/checkout.ts`, `apps/storefront/test/storefront.test.mjs`, `apps/storefront/test/rebuy.integration.mjs`, evidence mới và báo cáo này. Repository vẫn giữ các thay đổi có sẵn từ task trước; không commit/push.
