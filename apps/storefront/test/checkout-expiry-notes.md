# Rà soát đơn hết hạn — 10/11/2026

Đơn trong ảnh `a4ed8e5d-dbdd-4ab1-88da-0ddace123604` được tạo lúc 17:11:45, hết hạn 17:41:45 và hủy 17:41:46 giờ Việt Nam; failureCode RESERVATION_EXPIRED. Database UTC và TTL 30 phút nhất quán. Không có bằng chứng đơn này bị hết hạn ngay khi tạo; lúc chụp 17:44, nó đã quá hạn.

Rà soát Sales create (database clock + 30 phút), Inventory reserve (min deadline request, database clock + TTL), Sales recovery và UI countdown. Không đổi TTL, không reset thời gian, không mở lại đơn đã hủy. Không sửa backend/database.

Vấn đề UX: checkout giữ attempt đã biết orderId trong session, nên vào lại checkout có thể dẫn tới đơn cũ đã kết thúc. Bản sửa:

- Checkout đọc lại trạng thái đơn trước bằng quyền tra cứu hiện có.
- Khi backend trả CANCELLED/CONFIRMED, hiển thị rõ đơn trước đã kết thúc và nút đặt đơn mới.
- Nút luôn GET kiểm tra lại trạng thái trước khi bỏ active attempt; chỉ cho phép trạng thái terminal. Giữ lịch sử, không tạo lại orderId/idempotency key cũ. Nếu request lỗi hoặc đơn đang xử lý, không mở lượt mới.
- Guest tracking nêu giờ hết hạn thực tế tại Việt Nam và giải thích mở lại link không bắt đầu lượt giữ hàng mới.
- Card thanh toán demo của task trước được đóng gói cùng bản Storefront này; không xác nhận thanh toán thật.

Kiểm thử: 44 Storefront tests PASS, typecheck/lint PASS. Có regression cho CANCELLED/CONFIRMED, các trạng thái đang xử lý, lỗi tải đơn trước và format giờ hết hạn.

End-to-end với API thật qua Vite: tạo đơn demo mới, backend AWAITING_PAYMENT với đúng 1800 giây giữ hàng; card demo hiện, nhấn nút mô phỏng; hủy qua UI để dọn đơn thử; vào lại checkout nhận nút đặt mới, bấm và form mới mở sau authoritative GET. Ảnh/result ở `test/evidence/checkout-expiry/`. Không thay thời gian hoặc dữ liệu để giả lập hết hạn.

Đã build/recreate riêng Storefront và kiểm tra lại qua Docker `http://localhost:8081`: PASS; container running/healthy. Đơn thử Docker có AWAITING_PAYMENT, đúng 1800 giây giữ hàng, nút demo và luồng đặt mới sau khi hủy hoạt động. Đơn thử đã được hủy bằng UI, không reset hoặc sửa dữ liệu trực tiếp. Không đổi trạng thái đơn cũ trong ảnh.
