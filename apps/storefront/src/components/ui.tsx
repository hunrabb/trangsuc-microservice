import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ShopProduct } from '../api/shop.ts';
import {
  money,
  productPrice,
  safeImageUrl,
  matchingVariants,
  type VariantFilters,
} from '../state/catalog.ts';

export function Icon({
  name,
  size = 20,
}: {
  name:
    | 'bag'
    | 'search'
    | 'arrow'
    | 'close'
    | 'menu'
    | 'check'
    | 'diamond'
    | 'clock'
    | 'minus'
    | 'plus'
    | 'shield'
    | 'chevron';
  size?: number;
}) {
  const paths = {
    bag: (
      <>
        <path d="M5 7h14l1 14H4L5 7Z" />
        <path d="M9 8V5a3 3 0 0 1 6 0v3" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    arrow: (
      <>
        <path d="M3 12h18m-6-6 6 6-6 6" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    check: <path d="m5 12 4 4L19 6" />,
    diamond: (
      <>
        <path d="m3 8 4-5h10l4 5-9 13L3 8Z" />
        <path d="M3 8h18M7 3l5 18 5-18" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    minus: <path d="M5 12h14" />,
    plus: <path d="M5 12h14M12 5v14" />,
    shield: (
      <>
        <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function ProductImage({
  product,
  className = '',
}: {
  product: Pick<ShopProduct, 'name' | 'imageUrl'>;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = safeImageUrl(product.imageUrl);
  return (
    <div className={`product-image ${className}`}>
      {url && failedUrl !== url ? (
        <img
          key={url}
          src={url}
          alt={product.name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <div
          className="image-placeholder"
          role="img"
          aria-label={`${product.name}. Hình ảnh đang được cập nhật`}
        >
          <Icon name="diamond" size={64} />
          <span>Hình ảnh đang được cập nhật</span>
        </div>
      )}
    </div>
  );
}
export function ProductCard({
  product,
  filters,
}: {
  product: ShopProduct;
  filters?: VariantFilters;
}) {
  const price = productPrice(product, filters);
  const variants = matchingVariants(product, filters);
  const inStock = variants.some((variant) => variant.inStock);
  return (
    <article className="product-card">
      <Link to={`/san-pham/${product.id}`} className="product-card-link">
        <div className="card-gallery">
          <ProductImage product={product} />
          <span className={`stock-tag ${inStock ? '' : 'muted'}`}>
            {inStock ? 'Còn hàng' : 'Tạm hết hàng'}
          </span>
          <span className="card-arrow">
            <Icon name="arrow" />
          </span>
        </div>
        <div className="product-card-meta">
          <span className="eyebrow">{product.categoryName}</span>
          <h3>{product.name}</h3>
          <p>
            {price !== null && variants.length > 1 && <span className="subtle">Từ </span>}
            {money(price)}
          </p>
        </div>
      </Link>
    </article>
  );
}
export function StatePanel({
  title,
  children,
  action,
  kind = 'neutral',
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  kind?: string;
}) {
  return (
    <div className={`state-panel ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="state-icon">
        <Icon name={kind === 'error' ? 'clock' : 'diamond'} size={28} />
      </div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && <div className="state-actions">{action}</div>}
    </div>
  );
}
export function LoadingProducts({ count = 6 }: { count?: number }) {
  return (
    <div className="product-grid" aria-busy="true" aria-label="Đang tải sản phẩm">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton-card" key={i}>
          <div className="skeleton-image" />
          <div className="skeleton-line" />
          <div className="skeleton-line short" />
        </div>
      ))}
    </div>
  );
}
export function Breadcrumb({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Đường dẫn trang" className="breadcrumb">
      <Link to="/">Trang chủ</Link>
      {items.map((item, i) => (
        <span key={i}>
          <Icon name="chevron" size={12} />
          {item.to ? (
            <Link to={item.to}>{item.label}</Link>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
export function Quantity({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: number;
  onChange(value: number): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="quantity-control" role="group" aria-label={label}>
      <button
        type="button"
        aria-label={`Giảm số lượng: ${label}`}
        disabled={disabled || value <= 1}
        onClick={() => onChange(value - 1)}
      >
        <Icon name="minus" size={14} />
      </button>
      <output aria-live="polite">{value}</output>
      <button
        type="button"
        aria-label={`Tăng số lượng: ${label}`}
        disabled={disabled || value >= 10}
        onClick={() => onChange(value + 1)}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
export function PriceNote() {
  return (
    <p className="fine-print">
      Giá và tình trạng hàng là thông tin tham khảo. Giá đơn được cửa hàng xác nhận khi kiểm tra và
      giữ sản phẩm.
    </p>
  );
}
