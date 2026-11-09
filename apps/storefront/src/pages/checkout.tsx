import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { createOnlineOrderSchema } from '@jewelry/contracts';
import { ShopApiError } from '../api/shop.ts';
import { useCartProducts, useStore } from '../state/store.tsx';
import { money } from '../state/catalog.ts';
import { Breadcrumb, Icon, PriceNote, StatePanel } from '../components/ui.tsx';

export function CheckoutPage() {
  const store = useStore();
  const cart = useCartProducts();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const active = store.vault.active();
  async function resolve(retry = false) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const order = await (retry ? store.coordinator.retrySame() : store.coordinator.recover());
      store.refreshSession();
      navigate(`/don-hang/${order.id}`);
    } catch (error) {
      setMessage(
        error instanceof ShopApiError && error.status === 404
          ? 'Chưa tìm thấy đơn vào lúc kiểm tra. Yêu cầu trước vẫn có thể đang được xử lý; bạn có thể kiểm tra lại hoặc gửi lại đúng yêu cầu đã lưu.'
          : error instanceof Error
            ? error.message
            : 'Chưa xác định được kết quả. Vui lòng kiểm tra lại.',
      );
    } finally {
      setBusy(false);
      store.refreshSession();
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || store.coordinator.busy || !cart.ready || cart.loading || cart.error) return;
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (values.email === '') delete values.email;
    const body = createOnlineOrderSchema.safeParse({
      ...values,
      items: store.cart.map(({ variantId, quantity }) => ({ variantId, quantity })),
    });
    if (!body.success) {
      const fields: Record<string, string> = {};
      const texts: Record<string, string> = {
        recipientName: 'Vui lòng nhập tên người nhận, tối đa 150 ký tự.',
        recipientPhone: 'Vui lòng nhập số điện thoại 9–15 chữ số, có thể bắt đầu bằng +.',
        shippingAddress: 'Vui lòng nhập địa chỉ nhận hàng đầy đủ, từ 10 đến 1.000 ký tự.',
        email: 'Địa chỉ email chưa hợp lệ.',
      };
      for (const issue of body.error.issues) {
        const key = String(issue.path[0]);
        fields[key] = texts[key] ?? 'Vui lòng kiểm tra lại thông tin sản phẩm.';
      }
      setErrors(fields);
      const first = form.elements.namedItem(Object.keys(fields)[0]);
      if (first instanceof HTMLElement) first.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    setMessage('');
    try {
      const order = await store.coordinator.submit(body.data);
      store.refreshSession();
      navigate(`/don-hang/${order.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Chưa xác định được kết quả đặt hàng.');
      store.refreshSession();
    } finally {
      setBusy(false);
    }
  }
  const field = (
    name: string,
    label: string,
    type = 'text',
    autoComplete = '',
    optional = false,
  ) => (
    <label className="field-label" htmlFor={`checkout-${name}`}>
      {label}
      {optional && <span className="optional">Không bắt buộc</span>}
      <input
        id={`checkout-${name}`}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={!optional}
        maxLength={name === 'recipientName' ? 150 : name === 'email' ? 254 : 16}
        aria-invalid={!!errors[name]}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
      />
      {errors[name] && (
        <span id={`${name}-error`} className="field-error">
          {errors[name]}
        </span>
      )}
    </label>
  );
  return (
    <div className="container shopping-page">
      <Breadcrumb items={[{ label: 'Giỏ hàng', to: '/gio-hang' }, { label: 'Đặt hàng' }]} />
      <div className="checkout-title">
        <p className="eyebrow">A THOUGHTFUL CHOICE</p>
        <h1>
          Thêm một chút
          <br />
          <em>dấu ấn riêng.</em>
        </h1>
        <div className="checkout-steps" aria-label="Các bước đặt hàng">
          <span className="done">01 Giỏ hàng</span>
          <i />
          <span className="active">02 Thông tin nhận hàng</span>
          <i />
          <span>03 Kiểm tra đơn</span>
        </div>
      </div>
      {active ? (
        <StatePanel
          title={
            active.orderId ? 'Bạn đã có một yêu cầu đặt hàng' : 'Yêu cầu của bạn đang được kiểm tra'
          }
          action={
            <>
              {active.orderId ? (
                <Link className="button button-dark" to={`/don-hang/${active.orderId}`}>
                  Theo dõi đơn của bạn <Icon name="arrow" size={16} />
                </Link>
              ) : (
                <>
                  <button
                    className="button button-dark"
                    disabled={busy}
                    onClick={() => void resolve()}
                  >
                    Kiểm tra kết quả đã gửi
                  </button>
                  {active.body && (
                    <button
                      className="button button-outline"
                      disabled={busy}
                      onClick={() => void resolve(true)}
                    >
                      Gửi lại đúng yêu cầu đã lưu
                    </button>
                  )}
                </>
              )}
            </>
          }
        >
          Thông tin truy hồi đã được giữ trong tab này. Hãy xác định kết quả yêu cầu hiện tại trước
          khi bắt đầu một đơn mới.
        </StatePanel>
      ) : !store.cart.length ? (
        <StatePanel
          title="Bạn chưa có sản phẩm để đặt"
          action={
            <Link className="button button-dark" to="/bo-suu-tap">
              Khám phá bộ sưu tập
            </Link>
          }
        />
      ) : (
        <form className="shopping-layout checkout-layout" onSubmit={submit} noValidate>
          <section className="checkout-form">
            <div className="form-section-heading">
              <span>01</span>
              <div>
                <h2>Thông tin nhận hàng</h2>
                <p>Để cửa hàng liên hệ và xử lý yêu cầu của bạn.</p>
              </div>
            </div>
            <div className="form-grid">
              {field('recipientName', 'Họ và tên', 'text', 'shipping name')}
              {field('recipientPhone', 'Số điện thoại', 'tel', 'shipping tel')}
              <label className="field-label full-field" htmlFor="checkout-address">
                Địa chỉ nhận hàng
                <textarea
                  id="checkout-address"
                  name="shippingAddress"
                  autoComplete="shipping street-address"
                  rows={3}
                  maxLength={1000}
                  required
                  aria-invalid={!!errors.shippingAddress}
                  aria-describedby={errors.shippingAddress ? 'shippingAddress-error' : undefined}
                />
                {errors.shippingAddress && (
                  <span className="field-error" id="shippingAddress-error">
                    {errors.shippingAddress}
                  </span>
                )}
              </label>
              <div className="full-field">{field('email', 'Email', 'email', 'email', true)}</div>
            </div>
            <div className="checkout-explanation">
              <Icon name="clock" size={22} />
              <div>
                <h3>Điều gì xảy ra sau khi gửi yêu cầu?</h3>
                <p>
                  Cửa hàng kiểm tra lại giá và sản phẩm, sau đó giữ hàng có thời hạn cho đơn đủ điều
                  kiện. Bạn sẽ thấy kết quả ở trang theo dõi đơn.
                </p>
              </div>
            </div>
            <p className="fine-print">
              Quyền tra cứu lưu riêng trong tab này, tối đa 72 giờ. Không chia sẻ mã truy cập của
              bạn.
            </p>
          </section>
          <aside className="order-summary">
            <p className="eyebrow">YÊU CẦU CỦA BẠN</p>
            <h2>Xem lại trước khi đặt</h2>
            {cart.loading ? (
              <p role="status">Đang kiểm tra sản phẩm…</p>
            ) : (
              cart.lines.map((line) => (
                <div className="checkout-summary-line" key={line.item.variantId}>
                  <div>
                    <strong>{line.product?.name ?? 'Sản phẩm chưa khả dụng'}</strong>
                    <span>
                      {line.variant?.name} · {line.item.quantity} chiếc
                    </span>
                    {!line.available && (
                      <span className="field-error">Vui lòng chọn lại trong giỏ.</span>
                    )}
                  </div>
                  <span>{money(line.subtotal)}</span>
                </div>
              ))
            )}
            <div className="summary-total">
              <span>Tổng giá tham khảo</span>
              <strong>{money(cart.total)}</strong>
            </div>
            <PriceNote />
            {(cart.error || !cart.ready) && !cart.loading && (
              <p className="form-error">
                Vui lòng <Link to="/gio-hang">kiểm tra lại giỏ hàng</Link> trước khi tiếp tục.
              </p>
            )}
            <button
              className="button button-dark full-width"
              type="submit"
              disabled={busy || cart.loading || cart.error || !cart.ready}
            >
              {busy ? 'Đang gửi yêu cầu…' : 'Gửi yêu cầu đặt hàng'}
              <Icon name="arrow" size={16} />
            </button>
            <p className="summary-footnote">Bước này chưa xác nhận đã mua hàng hoặc thanh toán.</p>
          </aside>
        </form>
      )}
      {message && (
        <div className="notice warning checkout-message" role="alert">
          {message}
        </div>
      )}
    </div>
  );
}
