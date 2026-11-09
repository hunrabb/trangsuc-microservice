import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { shopProductSchema } from '@jewelry/contracts';
import { shopApi, canRetryRead, ShopApiError, type ShopProduct } from '../api/shop.ts';
import { money, metalName } from '../state/catalog.ts';
import { useStore } from '../state/store.tsx';
import {
  Breadcrumb,
  Icon,
  PriceNote,
  ProductImage,
  Quantity,
  StatePanel,
} from '../components/ui.tsx';

export function ProductDetail({ product }: { product: ShopProduct }) {
  const [selected, setSelected] = useState(
    product.variants.find((v) => v.inStock)?.id ?? product.variants[0]?.id ?? '',
  );
  const [quantity, setQuantity] = useState(1);
  const [feedback, setFeedback] = useState('');
  const { add } = useStore();
  const variant = product.variants.find((v) => v.id === selected);
  const available = !!variant?.inStock && variant.estimatedPrice !== null;
  return (
    <>
      <Breadcrumb items={[{ label: 'Bộ sưu tập', to: '/bo-suu-tap' }, { label: product.name }]} />
      <div className="product-detail-layout">
        <div className="detail-gallery">
          <ProductImage product={product} />
          <p>
            <Icon name="diamond" size={15} /> {product.categoryName}
          </p>
        </div>
        <section className="detail-copy">
          <Link
            className="eyebrow category-label"
            to={`/bo-suu-tap?categoryId=${product.categoryId}`}
          >
            {product.categoryName}
          </Link>
          <h1>{product.name}</h1>
          <p className="sku-label">
            {variant ? `Mã sản phẩm · ${variant.sku}` : 'Lựa chọn đang được cập nhật'}
          </p>
          <p className="detail-price">{money(variant?.estimatedPrice ?? null)}</p>
          <span className={`availability ${available ? 'in-stock' : ''}`}>
            <i />
            {available ? 'Có thể gửi yêu cầu đặt hàng' : 'Lựa chọn này hiện chưa khả dụng'}
          </span>
          {product.description && <p className="product-description">{product.description}</p>}
          <fieldset className="variant-field">
            <legend>Lựa chọn sản phẩm</legend>
            <div className="variant-options">
              {product.variants.map((v) => (
                <label
                  key={v.id}
                  className={`variant-option ${v.id === selected ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="variant"
                    value={v.id}
                    checked={v.id === selected}
                    onChange={() => {
                      setSelected(v.id);
                      setFeedback('');
                    }}
                  />
                  <span>
                    {v.name}
                    <small>
                      {metalName(v.metalKind)}
                      {!v.inStock ? ' · Tạm hết hàng' : ''}
                    </small>
                  </span>
                  {v.id === selected && <Icon name="check" size={17} />}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="detail-add">
            <div>
              <label>Số lượng</label>
              <Quantity
                value={quantity}
                onChange={setQuantity}
                label={product.name}
                disabled={!available}
              />
            </div>
            <button
              className="button button-dark"
              disabled={!available}
              onClick={() => {
                try {
                  add(product, selected, quantity);
                  setFeedback(
                    'Đã thêm vào giỏ. Bạn có thể tiếp tục khám phá hoặc xem lại giỏ hàng.',
                  );
                } catch (error) {
                  setFeedback(error instanceof Error ? error.message : 'Chưa thể thêm vào giỏ.');
                }
              }}
            >
              <Icon name="bag" size={18} />
              Thêm vào giỏ
            </button>
          </div>
          {feedback && (
            <p className="inline-feedback" role="status">
              {feedback} <Link to="/gio-hang">Xem giỏ hàng</Link>
            </p>
          )}
          <PriceNote />
          <div className="detail-facts">
            <div>
              <span>Chất liệu</span>
              <strong>{variant ? metalName(variant.metalKind) : 'Đang cập nhật'}</strong>
            </div>
            <div>
              <span>Đơn vị lựa chọn</span>
              <strong>Theo chiếc</strong>
            </div>
          </div>
          <Link to="/huong-dan" className="text-link">
            Tìm hiểu quy trình đặt hàng <Icon name="arrow" size={16} />
          </Link>
        </section>
      </div>
    </>
  );
}
export function ProductPage() {
  const { productId = '' } = useParams();
  const valid = shopProductSchema.shape.id.safeParse(productId).success;
  const product = useQuery({
    queryKey: ['product', productId],
    queryFn: ({ signal }) => shopApi.product(productId, signal),
    enabled: valid,
    staleTime: 30_000,
    retry: canRetryRead,
  });
  return (
    <div className="container detail-page">
      {!valid || (product.error instanceof ShopApiError && product.error.status === 404) ? (
        <StatePanel
          title="Sản phẩm hiện không khả dụng"
          action={
            <Link className="button button-dark" to="/bo-suu-tap">
              Khám phá bộ sưu tập
            </Link>
          }
        >
          Sản phẩm có thể đã ngừng hiển thị hoặc đang được cập nhật.
        </StatePanel>
      ) : product.isPending ? (
        <div className="detail-skeleton" aria-busy="true" aria-label="Đang tải chi tiết sản phẩm">
          <div className="skeleton-image" />
          <div>
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
          </div>
        </div>
      ) : product.isError ? (
        <StatePanel
          kind="error"
          title="Chưa thể tải sản phẩm"
          action={
            <button className="button button-outline" onClick={() => void product.refetch()}>
              Thử lại
            </button>
          }
        >
          Vui lòng kiểm tra kết nối và thử lại.
        </StatePanel>
      ) : (
        <ProductDetail key={product.data.id} product={product.data} />
      )}
    </div>
  );
}
