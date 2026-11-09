import { useState } from 'react';
import { Link } from 'react-router';
import { useStore, useCartProducts } from '../state/store.tsx';
import { money, metalName } from '../state/catalog.ts';
import {
  Breadcrumb,
  Icon,
  PriceNote,
  ProductImage,
  Quantity,
  StatePanel,
} from '../components/ui.tsx';

export function CartPage() {
  const { cart, quantity } = useStore();
  const checked = useCartProducts();
  const [error, setError] = useState('');
  return (
    <div className="container shopping-page">
      <Breadcrumb items={[{ label: 'Giỏ hàng' }]} />
      <div className="page-intro compact">
        <p className="eyebrow">YOUR SELECTION</p>
        <h1>
          Những lựa chọn
          <br />
          <em>của bạn.</em>
        </h1>
        <p>Giữ lại điều bạn yêu thích, rồi xem lại trước khi đặt hàng.</p>
      </div>
      {!cart.length ? (
        <StatePanel
          title="Giỏ hàng đang chờ những lựa chọn mới"
          action={
            <Link className="button button-dark" to="/bo-suu-tap">
              Khám phá bộ sưu tập <Icon name="arrow" size={17} />
            </Link>
          }
        >
          Thêm sản phẩm bạn yêu thích để bắt đầu.
        </StatePanel>
      ) : (
        <div className="shopping-layout">
          <section className="cart-lines" aria-label="Sản phẩm trong giỏ">
            {checked.loading && (
              <p role="status" className="notice">
                Đang kiểm tra lại sản phẩm và giá tham khảo…
              </p>
            )}
            {checked.error && (
              <div className="notice warning" role="alert">
                Một số sản phẩm chưa thể kiểm tra.{' '}
                <button className="text-button" onClick={() => void checked.retry()}>
                  Tải lại thông tin
                </button>
              </div>
            )}
            {checked.lines.map((line) => (
              <article className="cart-line" key={line.item.variantId}>
                <Link className="cart-image" to={`/san-pham/${line.item.productId}`}>
                  <ProductImage
                    product={
                      line.product ?? { name: 'Sản phẩm không còn hiển thị', imageUrl: null }
                    }
                  />
                </Link>
                <div className="cart-line-info">
                  <span className="eyebrow">
                    {line.product?.categoryName ?? 'SẢN PHẨM TRONG GIỎ'}
                  </span>
                  <h2>
                    {line.product ? (
                      <Link to={`/san-pham/${line.product.id}`}>{line.product.name}</Link>
                    ) : (
                      'Sản phẩm hiện không khả dụng'
                    )}
                  </h2>
                  <p>
                    {line.variant
                      ? `${line.variant.name} · ${metalName(line.variant.metalKind)} · ${line.variant.sku}`
                      : 'Chưa thể xác nhận lựa chọn này.'}
                  </p>
                  {!checked.loading && !line.available && (
                    <span className="unavailable-note">
                      Vui lòng bỏ món này hoặc chọn lại sản phẩm trước khi đặt hàng.
                    </span>
                  )}
                  <div className="cart-line-actions">
                    <Quantity
                      value={line.item.quantity}
                      label={line.product?.name ?? 'Sản phẩm'}
                      disabled={!line.available}
                      onChange={(value) => {
                        try {
                          quantity(line.item, value);
                          setError('');
                        } catch {
                          setError('Giỏ giới hạn 10 chiếc mỗi lựa chọn và 50 chiếc tất cả.');
                        }
                      }}
                    />
                    <button
                      className="remove-button"
                      onClick={() => quantity(line.item, 0)}
                      aria-label={`Bỏ ${line.product?.name ?? 'sản phẩm'} khỏi giỏ`}
                    >
                      Bỏ khỏi giỏ
                    </button>
                  </div>
                </div>
                <p className="cart-line-price">{money(line.subtotal)}</p>
              </article>
            ))}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Link className="text-link continue-shopping" to="/bo-suu-tap">
              Tiếp tục khám phá <Icon name="arrow" size={16} />
            </Link>
          </section>
          <aside className="order-summary">
            <p className="eyebrow">XEM LẠI LỰA CHỌN</p>
            <h2>Giỏ hàng của bạn</h2>
            <div className="summary-row">
              <span>Số lượng</span>
              <strong>{cart.reduce((n, item) => n + item.quantity, 0)} chiếc</strong>
            </div>
            <div className="summary-total">
              <span>Tổng giá tham khảo</span>
              <strong>{checked.loading ? 'Đang kiểm tra…' : money(checked.total)}</strong>
            </div>
            <PriceNote />
            {checked.ready && !checked.loading && !checked.error ? (
              <Link className="button button-dark full-width" to="/dat-hang">
                Tiếp tục đặt hàng <Icon name="arrow" size={16} />
              </Link>
            ) : (
              <button className="button button-dark full-width" disabled>
                Kiểm tra sản phẩm để tiếp tục
              </button>
            )}
            <p className="summary-footnote">
              <Icon name="shield" size={16} />
              Thêm vào giỏ chưa giữ sản phẩm.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
