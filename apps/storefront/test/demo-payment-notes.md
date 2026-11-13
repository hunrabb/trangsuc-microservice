# Demo payment UI — 10/11/2026

Chỉ thay đổi Storefront và frontend tests, không sửa hoặc gọi API xác nhận thanh toán nội bộ.

- `src/components/demo-payment.tsx`: card espresso/ivory, SVG minh họa QR có chữ DEMO phủ giữa, không mã hóa payload và không chứa tài khoản/ngân hàng/VietQR. Badge và mô tả yêu cầu không chuyển tiền thật.
- `src/pages/orders.tsx`: PaymentGuidance dùng card mới, được dùng chung bởi guest tracking và account order detail. Giữ query/loading/error/refetch hiện tại.
- `src/luxury.css`: layout QR/số tiền/nội dung demo, responsive và phản hồi thao tác.
- `test/storefront.test.mjs`: kiểm tra số tiền chính xác, nhãn demo và ẩn card theo lifecycle/null total/needsReview.
- `test/demo-payment.browser.html` và `.mjs`: harness kiểm thử component riêng, không phải route sản phẩm hay mock runtime của ứng dụng.
- `test/evidence/demo-payment/`: ảnh desktop/mobile và kết quả browser.

Card chỉ hiện khi backend trả AWAITING_PAYMENT, có total và không needsReview. Nút “Tôi đã chuyển khoản (Demo)” chỉ set local React state, hiện thông báo “Đã ghi nhận thao tác mô phỏng trên trang này. Đơn hàng vẫn chờ nhân viên xác nhận.” Không gửi request, không persistence hoặc thay đổi order/payment status.

Backend thật không có trạng thái PAID trong DTO Storefront; xác nhận hoàn tất là CONFIRMED. ADMIN/MANAGER tiếp tục xác nhận theo API hiện có; card tự biến mất sau khi query nhận PAYMENT_PROCESSING/CONFIRMED hoặc trạng thái không phù hợp. Không tích hợp chuyển khoản, webhook hoặc gửi chứng từ/thông báo thật.

## Kết quả

- Typecheck, ESLint, Prettier: PASS.
- 42 Storefront tests: PASS, bao gồm các regression checkout/tracking và lỗi dữ liệu sẵn có.
- Production build: PASS.
- Chromium 1440px và 390px: PASS. Hiển thị 1.234.567,89 đồng từ test DTO, bấm nút hiện thông báo cục bộ, không request API/payment/admin, status giữ AWAITING_PAYMENT, card biến mất khi test DTO đổi CONFIRMED hoặc các trạng thái không phù hợp. Không overflow.
- Browser chỉ kiểm thử component bằng harness, không xác nhận thanh toán thật trên backend. Lỗi tải dữ liệu giữ nguyên hành vi trang và được kiểm tra bởi tests sẵn có; chưa ép lỗi mạng trong browser lần này.
- Không deploy lại Docker trong task này. Source và production build đã hoàn thành; Vite tại http://localhost:5174 có code mới. Docker 8081 vẫn dùng image trước đó.

Chạy browser test khi Vite đang phục vụ localhost:5174 và đã có Playwright/Chromium:

```bash
node apps/storefront/test/demo-payment.browser.mjs
```

Có thể đặt `PLAYWRIGHT_MODULE` thành đường dẫn tuyệt đối tới module Playwright đã cài và `STOREFRONT_TEST_URL` để thay địa chỉ Vite. Browser test không nằm trong lệnh tests mặc định và không bổ sung dependency nặng cho Storefront.
