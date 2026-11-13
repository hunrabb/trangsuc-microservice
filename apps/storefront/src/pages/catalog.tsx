import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { shopQuerySchema, type ShopQuery } from '@jewelry/contracts';
import { canRetryRead, shopApi } from '../api/shop.ts';
import { catalogParams, catalogQuery } from '../state/catalog.ts';
import { Breadcrumb, Icon, LoadingProducts, ProductCard, StatePanel } from '../components/ui.tsx';

export function CatalogFilters({
  query,
  categories,
  onApply,
}: {
  query: ShopQuery;
  categories: { id: string; name: string }[];
  onApply(query: ShopQuery): void;
}) {
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const data = Object.fromEntries([...form.entries()].filter(([, value]) => value !== ''));
    const checked = shopQuerySchema.safeParse({ ...data, page: 1, pageSize: 12 });
    if (!checked.success) {
      setError(
        'Vui lòng kiểm tra khoảng giá: chỉ nhập số không âm và giá tối đa không nhỏ hơn giá tối thiểu.',
      );
      return;
    }
    setError('');
    onApply(checked.data);
  }
  return (
    <form className="filter-form" onSubmit={submit}>
      <label className="search-field">
        <span className="sr-only">Tìm tên sản phẩm hoặc mã SKU</span>
        <Icon name="search" size={18} />
        <input
          name="search"
          type="search"
          maxLength={100}
          defaultValue={query.search}
          placeholder="Tên sản phẩm hoặc mã SKU"
        />
      </label>
      <fieldset>
        <legend>Chất liệu</legend>
        {[
          { value: '', label: 'Tất cả chất liệu' },
          { value: 'GOLD', label: 'Vàng' },
          { value: 'SILVER', label: 'Bạc' },
        ].map((item) => (
          <label className="radio-label" key={item.value}>
            <input
              type="radio"
              name="metalKind"
              value={item.value}
              defaultChecked={(query.metalKind ?? '') === item.value}
            />
            <span>{item.label}</span>
          </label>
        ))}
      </fieldset>
      {(categories.length > 0 || query.categoryId) && (
        <label className="field-label">
          Danh mục
          <select name="categoryId" defaultValue={query.categoryId ?? ''}>
            <option value="">Tất cả danh mục đang xem</option>
            {query.categoryId && !categories.some((c) => c.id === query.categoryId) && (
              <option value={query.categoryId}>Danh mục đã chọn</option>
            )}
            {categories.map((category) => (
              <option value={category.id} key={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <span className="fine-print">Danh mục lấy từ các sản phẩm đang hiển thị.</span>
        </label>
      )}
      <fieldset>
        <legend>Khoảng giá tham khảo</legend>
        <div className="price-filter">
          <label>
            <span>Từ (₫)</span>
            <input
              name="minPrice"
              inputMode="decimal"
              defaultValue={query.minPrice}
              placeholder="0"
              maxLength={16}
            />
          </label>
          <span className="price-dash">—</span>
          <label>
            <span>Đến (₫)</span>
            <input
              name="maxPrice"
              inputMode="decimal"
              defaultValue={query.maxPrice}
              placeholder="Không giới hạn"
              maxLength={16}
            />
          </label>
        </div>
      </fieldset>
      <label className="field-label">
        Sắp xếp
        <select name="sort" defaultValue={query.sort}>
          <option value="name">Tên sản phẩm A–Z</option>
          <option value="price_asc">Giá từ thấp đến cao</option>
          <option value="price_desc">Giá từ cao đến thấp</option>
        </select>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="button button-dark full-width" type="submit">
        Áp dụng lựa chọn <Icon name="arrow" size={16} />
      </button>
      <button
        type="button"
        className="text-button"
        onClick={() => onApply(shopQuerySchema.parse({ pageSize: 12 }))}
      >
        Xoá bộ lọc
      </button>
    </form>
  );
}
export function CatalogPage() {
  const [params, setParams] = useSearchParams();
  const parsed = catalogQuery(params);
  const query = parsed.success ? parsed.data : shopQuerySchema.parse({ pageSize: 12 });
  const collectionName =
    query.metalKind === 'GOLD'
      ? 'Trang sức vàng'
      : query.metalKind === 'SILVER'
        ? 'Trang sức bạc'
        : 'Bộ sưu tập';
  const products = useQuery({
    queryKey: ['catalog', query],
    queryFn: ({ signal }) => shopApi.list(query, signal),
    enabled: parsed.success,
    staleTime: 30_000,
    retry: canRetryRead,
  });
  const categories = [
    ...new Map(
      products.data?.items.map((product) => [
        product.categoryId,
        { id: product.categoryId, name: product.categoryName },
      ]) ?? [],
    ).values(),
  ];
  const [filterOpen, setFilterOpen] = useState(false);
  const apply = (next: ShopQuery) => {
    setParams(catalogParams(next));
    setFilterOpen(false);
    requestAnimationFrame(() => {
      const results = document.getElementById('catalog-results');
      results?.focus({ preventScroll: true });
      results?.scrollIntoView({ block: 'start' });
    });
  };
  const pages = Math.min(
    10000,
    Math.max(1, Math.ceil((products.data?.total ?? 0) / query.pageSize)),
  );
  return (
    <div className="container catalog-page">
      <Breadcrumb items={[{ label: collectionName }]} />
      <div className="page-intro">
        <p className="eyebrow">THE COLLECTION</p>
        <h1>
          {query.metalKind ? collectionName : 'Tìm món trang sức'}
          <br />
          <em>mang dấu ấn của bạn.</em>
        </h1>
        <p>Khám phá theo chất liệu, danh mục và khoảng giá phù hợp.</p>
      </div>
      {!parsed.success ? (
        <StatePanel
          title="Bộ lọc chưa hợp lệ"
          kind="error"
          action={
            <button className="button button-outline" onClick={() => setParams({})}>
              Xoá bộ lọc và xem lại
            </button>
          }
        >
          Vui lòng chọn lại điều kiện tìm kiếm để tiếp tục khám phá.
        </StatePanel>
      ) : (
        <div className="catalog-layout">
          <aside className={`filter-sidebar ${filterOpen ? 'filter-open' : ''}`}>
            <button
              type="button"
              className="filter-toggle"
              aria-expanded={filterOpen}
              aria-controls="catalog-filters"
              onClick={() => setFilterOpen(!filterOpen)}
            >
              <Icon name="search" size={17} /> Tìm kiếm & bộ lọc{' '}
              <span>{filterOpen ? 'Đóng' : 'Mở'}</span>
            </button>
            <div id="catalog-filters" className="filter-content">
              <h2>Lựa chọn của bạn</h2>
              <CatalogFilters
                key={params.toString()}
                query={query}
                categories={categories}
                onApply={apply}
              />
            </div>
          </aside>
          <section
            id="catalog-results"
            className="catalog-results"
            tabIndex={-1}
            aria-label="Kết quả sản phẩm"
          >
            <div className="results-toolbar" aria-live="polite">
              <span>
                {products.data ? `${products.data.total} sản phẩm` : 'Đang tìm sản phẩm…'}
              </span>
              <span>Giá tham khảo · VND</span>
            </div>
            {products.isPending ? (
              <LoadingProducts />
            ) : products.isError ? (
              <StatePanel
                kind="error"
                title="Chưa thể tải bộ sưu tập"
                action={
                  <button className="button button-outline" onClick={() => void products.refetch()}>
                    Thử lại
                  </button>
                }
              >
                Kết nối đang gián đoạn. Các lựa chọn tìm kiếm của bạn vẫn được giữ lại.
              </StatePanel>
            ) : products.data?.items.length ? (
              <div className="product-grid">
                {products.data.items.map((product) => (
                  <ProductCard key={product.id} product={product} filters={query} />
                ))}
              </div>
            ) : (
              <StatePanel
                title="Chưa tìm thấy lựa chọn phù hợp"
                action={
                  <button
                    className="button button-outline"
                    onClick={() => apply(shopQuerySchema.parse({ pageSize: 12 }))}
                  >
                    Xem tất cả sản phẩm
                  </button>
                }
              >
                Thử mở rộng khoảng giá hoặc chọn chất liệu khác để tìm thêm sản phẩm.
              </StatePanel>
            )}
            {products.data && products.data.total > 0 && (
              <nav className="pagination" aria-label="Phân trang sản phẩm">
                <button
                  className="button button-outline"
                  disabled={query.page <= 1}
                  onClick={() => apply({ ...query, page: query.page - 1 })}
                >
                  Trang trước
                </button>
                <span>
                  Trang <strong>{query.page}</strong> / {pages}
                </span>
                <button
                  className="button button-outline"
                  disabled={query.page >= pages}
                  onClick={() => apply({ ...query, page: query.page + 1 })}
                >
                  Trang sau <Icon name="arrow" size={15} />
                </button>
              </nav>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
