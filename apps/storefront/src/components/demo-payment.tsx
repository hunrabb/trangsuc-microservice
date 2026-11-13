import { useState } from 'react';
import type { ShopOrder } from '../api/shop.ts';
import { money } from '../state/catalog.ts';
import { Icon } from './ui.tsx';

/** Illustration only: intentionally no QR encoding, bank account or payment payload. */
function DemoQrIllustration() {
  return (
    <svg
      className="demo-payment-qr"
      viewBox="0 0 200 200"
      role="img"
      aria-label="Minh họa QR demo, không quét để chuyển tiền"
    >
      <rect width="200" height="200" fill="#faf7f2" />
      {[
        [18, 18],
        [130, 18],
        [18, 130],
      ].map(([x, y]) => (
        <g key={`${x}-${y}`} fill="none" stroke="currentColor" strokeWidth="7">
          <rect x={x} y={y} width="48" height="48" rx="3" />
          <rect x={x + 16} y={y + 16} width="16" height="16" strokeWidth="4" />
        </g>
      ))}
      <path
        d="M86 18h20v18H86zm0 35h20v18H86zm44 40h20v18h-20zm31 0h18v18h-18zM18 86h18v20H18zm35 0h18v20H53zm77 44h18v18h-18zm32 32h18v18h-18zm-76-32h18v18H86zm0 32h18v18H86zm44 0h18v18h-18z"
        fill="currentColor"
        opacity=".55"
      />
      <rect x="22" y="76" width="156" height="48" rx="3" fill="#231914" />
      <text
        x="100"
        y="106"
        textAnchor="middle"
        fill="#faf7f2"
        fontFamily="Arial, sans-serif"
        fontSize="25"
        letterSpacing="5"
      >
        DEMO
      </text>
    </svg>
  );
}

function DemoPaymentCard({ order }: { order: ShopOrder }) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <section className="demo-payment" aria-labelledby={`demo-payment-${order.id}`}>
      <div className="demo-payment-topline">
        <Icon name="shield" size={20} />
        <span>DEMO — KHÔNG CHUYỂN TIỀN THẬT</span>
      </div>
      <div className="demo-payment-layout">
        <figure className="demo-payment-visual">
          <DemoQrIllustration />
          <figcaption>QR minh họa · Không dùng thanh toán</figcaption>
        </figure>
        <div className="demo-payment-copy">
          <p className="eyebrow">TRẢI NGHIỆM THANH TOÁN MÔ PHỎNG</p>
          <h2 id={`demo-payment-${order.id}`}>Một bước để trải nghiệm.</h2>
          <p>
            Không quét để chuyển khoản. Hình minh họa này không chứa ngân hàng, tài khoản hay dữ
            liệu thanh toán thật.
          </p>
          <dl>
            <div>
              <dt>Số tiền theo đơn</dt>
              <dd className="demo-payment-amount">{money(order.total)}</dd>
            </div>
            <div>
              <dt>Mã đơn</dt>
              <dd>{order.code}</dd>
            </div>
            <div>
              <dt>Nội dung minh họa</dt>
              <dd>DEMO {order.code}</dd>
            </div>
          </dl>
          <button
            type="button"
            className="button button-dark full-width"
            disabled={acknowledged}
            onClick={() => setAcknowledged(true)}
          >
            {acknowledged ? 'Đã ghi nhận mô phỏng tại đây' : 'Tôi đã chuyển khoản (Demo)'}
            <Icon name={acknowledged ? 'check' : 'arrow'} size={18} />
          </button>
          {acknowledged && (
            <p className="demo-payment-feedback" role="status">
              Đã ghi nhận thao tác mô phỏng trên trang này. Đơn hàng vẫn chờ nhân viên xác nhận.
            </p>
          )}
          <p className="fine-print">
            Thao tác chỉ hiển thị trên trang này, không gửi thông báo đến cửa hàng và không xác nhận
            thanh toán. Trạng thái đơn lấy từ hệ thống; bạn có thể chọn “Cập nhật trạng thái” để
            kiểm tra lại.
          </p>
        </div>
      </div>
    </section>
  );
}

export function DemoPayment({ order }: { order: ShopOrder }) {
  if (order.status !== 'AWAITING_PAYMENT' || order.total === null || order.needsReview) return null;
  return <DemoPaymentCard key={order.id} order={order} />;
}
