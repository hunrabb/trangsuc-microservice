import { Link } from 'react-router';
import { Breadcrumb, Icon } from '../components/ui.tsx';
export function GuidePage() {
  return (
    <div className="container guide-page">
      <Breadcrumb items={[{ label: 'Hướng dẫn đặt hàng' }]} />
      <div className="page-intro">
        <p className="eyebrow">HERE TO GUIDE YOU</p>
        <h1>
          Mỗi bước,
          <br />
          <em>đều rõ ràng.</em>
        </h1>
        <p>Những điều bạn cần biết trước khi gửi yêu cầu đặt hàng.</p>
      </div>
      <div className="guide-grid">
        {[
          [
            '01',
            'Khám phá & lựa chọn',
            'Xem thông tin, chất liệu và giá tham khảo. Ảnh chưa được cung cấp sẽ có thông báo ngay trên sản phẩm.',
          ],
          [
            '02',
            'Xem lại giỏ hàng',
            'Giỏ lưu lựa chọn trên trình duyệt nếu được cho phép. Thêm vào giỏ chưa giữ sản phẩm; giá và tình trạng hàng được kiểm tra lại khi đặt.',
          ],
          [
            '03',
            'Gửi yêu cầu đặt hàng',
            'Nhập thông tin người nhận. Cửa hàng kiểm tra sản phẩm và giá trước khi giữ hàng có thời hạn. Giữ tab để theo dõi kết quả nếu kết nối bị gián đoạn.',
          ],
          [
            '04',
            'Theo dõi & xác minh',
            'Chỉ chuyển khoản khi có hướng dẫn được cửa hàng xác nhận. Nhân viên xác minh khoản tiền nhận và trạng thái sản phẩm trước khi xác nhận đơn.',
          ],
        ].map(([number, title, description]) => (
          <section key={number}>
            <span className="guide-number">{number}</span>
            <h2>{title}</h2>
            <p>{description}</p>
          </section>
        ))}
      </div>
      <section className="guide-privacy" id="quyen-tra-cuu">
        <Icon name="shield" size={32} />
        <div>
          <h2>Đơn của bạn, quyền tra cứu của bạn</h2>
          <p>
            Quyền truy cập đơn lưu trong tab tối đa 72 giờ và có thể mất khi đóng tab. Bạn có thể
            sao chép mã truy cập riêng tại trang theo dõi để lưu an toàn. Không chia sẻ mã này công
            khai hoặc đưa vào liên kết.
          </p>
          <p>
            Nếu kết quả đặt hàng chưa rõ, hãy dùng “Kiểm tra kết quả đã gửi”. Gửi lại từ yêu cầu đã
            lưu vẫn sử dụng cùng thông tin tra cứu, giúp tránh tạo đơn ngoài ý muốn.
          </p>
          <Link className="text-link" to="/don-hang">
            Đến đơn của tôi <Icon name="arrow" size={17} />
          </Link>
        </div>
      </section>
      <div className="notice">
        Thông tin nhận chuyển khoản, mã QR và chức năng gửi chứng từ hiện chưa được cung cấp trên
        website. Yêu cầu hoàn tiền chỉ có nghĩa đã được ghi nhận, chưa phải xác nhận tiền đã hoàn.
      </div>
      <Link className="button button-dark" to="/bo-suu-tap">
        Bắt đầu khám phá <Icon name="arrow" size={17} />
      </Link>
    </div>
  );
}
