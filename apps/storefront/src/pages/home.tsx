import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { shopApi, canRetryRead } from '../api/shop.ts';
import { shopQuerySchema } from '@jewelry/contracts';
import { Icon, LoadingProducts, ProductCard, ProductImage, StatePanel } from '../components/ui.tsx';

export function HomePage() {
  const products = useQuery({
    queryKey: ['catalog', 'home'],
    queryFn: ({ signal }) => shopApi.list(shopQuerySchema.parse({ pageSize: 50 }), signal),
    staleTime: 60_000,
    retry: canRetryRead,
  });
  const available = products.data?.items ?? [];
  const photographed = available.filter((product) => product.imageUrl);
  const featured = (photographed.length ? photographed : available).slice(0, 4);
  const heroProduct = photographed[0];
  const goldProduct = photographed.find((product) =>
    product.variants.some((v) => v.metalKind === 'GOLD'),
  );
  const silverProduct = photographed.find((product) =>
    product.variants.some((v) => v.metalKind === 'SILVER'),
  );
  const categories = [
    ...new Map(
      available.map((product) => [
        product.categoryId,
        { id: product.categoryId, name: product.categoryName },
      ]) ?? [],
    ).values(),
  ];
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="tiny-line" />
            THE ART OF EVERYDAY
          </p>
          <h1>
            Vẻ đẹp tinh giản.
            <br />
            <em>Dấu ấn riêng bạn.</em>
          </h1>
          <p className="hero-description">
            Một điểm nhấn nhẹ nhàng, một khoảnh khắc đáng nhớ. Khám phá những món trang sức để kể
            câu chuyện của riêng mình.
          </p>
          <Link to="/bo-suu-tap" className="button button-dark">
            Khám phá bộ sưu tập <Icon name="arrow" size={18} />
          </Link>
          <span className="hero-caption">VÀNG & BẠC · BỘ SƯU TẬP TRỰC TUYẾN</span>
        </div>
        <div className="hero-art">
          <div className="hero-art-label">THE JEWELRY EDIT / 01</div>
          {heroProduct ? (
            <Link
              className="hero-product"
              to={`/san-pham/${heroProduct.id}`}
              aria-label={`Khám phá ${heroProduct.name}`}
            >
              <ProductImage product={heroProduct} />
              <span className="hero-product-caption">
                <span>{heroProduct.name}</span>
                <Icon name="arrow" size={24} />
              </span>
            </Link>
          ) : (
            <div className="hero-empty">
              <Icon name="diamond" size={100} />
              <span>Một nét riêng. Một dấu ấn.</span>
            </div>
          )}
          <div className="hero-art-bottom">
            <span>ĐƯỜNG NÉT & ÁNH SÁNG</span>
            <span>VÀNG · BẠC</span>
          </div>
        </div>
      </section>
      <section className="container collection-intro">
        <div>
          <p className="eyebrow">TÌM ĐIỂM NHẤN CỦA BẠN</p>
          <h2>
            Mỗi lựa chọn,
            <br />
            <em>một nét riêng.</em>
          </h2>
        </div>
        <div>
          <p>
            Bắt đầu từ chất liệu bạn yêu thích, rồi tìm món trang sức phù hợp với phong cách của
            mình.
          </p>
          <Link to="/bo-suu-tap" className="text-link">
            Xem toàn bộ bộ sưu tập <Icon name="arrow" size={17} />
          </Link>
        </div>
      </section>
      <section className="container material-grid" aria-label="Khám phá theo chất liệu">
        <Link to="/bo-suu-tap?metalKind=GOLD" className="material-tile gold-tile">
          {goldProduct && <ProductImage product={goldProduct} />}
          <div>
            <span className="eyebrow">SẮC ẤM TINH TẾ</span>
            <h3>Trang sức vàng</h3>
            <span className="text-link">
              Khám phá <Icon name="arrow" size={17} />
            </span>
          </div>
        </Link>
        <Link to="/bo-suu-tap?metalKind=SILVER" className="material-tile silver-tile">
          {silverProduct && <ProductImage product={silverProduct} />}
          <div>
            <span className="eyebrow">ÁNH SÁNG THANH NHÃ</span>
            <h3>Trang sức bạc</h3>
            <span className="text-link">
              Khám phá <Icon name="arrow" size={17} />
            </span>
          </div>
        </Link>
      </section>
      <section className="container section-pad">
        <div className="section-heading">
          <div>
            <p className="eyebrow">KHÁM PHÁ THÊM</p>
            <h2>Trong bộ sưu tập</h2>
          </div>
          <Link to="/bo-suu-tap" className="text-link">
            Xem tất cả <Icon name="arrow" size={17} />
          </Link>
        </div>
        {products.isPending ? (
          <LoadingProducts count={4} />
        ) : products.isError ? (
          <StatePanel
            kind="error"
            title="Bộ sưu tập đang chờ bạn"
            action={
              <button className="button button-outline" onClick={() => void products.refetch()}>
                Tải lại bộ sưu tập
              </button>
            }
          >
            Chưa thể tải sản phẩm lúc này. Bạn có thể thử lại sau ít phút.
          </StatePanel>
        ) : products.data?.items.length ? (
          <>
            <div className="product-grid home-products">
              {featured.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
            {categories.length > 0 && (
              <div className="category-links" aria-label="Danh mục từ sản phẩm đang hiển thị">
                {categories.map((category) => (
                  <Link key={category.id} to={`/bo-suu-tap?categoryId=${category.id}`}>
                    {category.name}
                    <Icon name="arrow" size={14} />
                  </Link>
                ))}
              </div>
            )}
          </>
        ) : (
          <StatePanel title="Bộ sưu tập đang được cập nhật">
            Các sản phẩm sẽ xuất hiện tại đây khi sẵn sàng để bạn khám phá.
          </StatePanel>
        )}
      </section>
      <section className="editorial-band">
        <div className="container">
          <p className="eyebrow">VẺ ĐẸP TRONG NHỮNG ĐIỀU GẦN GŨI</p>
          <h2>
            Không chỉ dành cho
            <br />
            <em>những dịp đặc biệt.</em>
          </h2>
          <p className="brand-story">
            Một chiếc nhẫn quen thuộc. Sợi dây chuyền bạn luôn chọn. Trang sức trở thành một phần
            câu chuyện khi được mang theo mỗi ngày. Khám phá những đường nét đồng điệu với bạn, theo
            cách riêng của bạn.
          </p>
          <div className="value-grid">
            <div>
              <Icon name="search" size={26} />
              <h3>Thông tin để lựa chọn</h3>
              <p>Xem chất liệu, biến thể và giá tham khảo được cập nhật từ cửa hàng.</p>
            </div>
            <div>
              <Icon name="bag" size={26} />
              <h3>Kiểm tra trước khi xác nhận</h3>
              <p>Giá và sản phẩm được kiểm tra lại khi bạn gửi yêu cầu đặt hàng.</p>
            </div>
            <div>
              <Icon name="shield" size={26} />
              <h3>Theo dõi đơn riêng tư</h3>
              <p>Mỗi đơn có quyền truy cập riêng để bạn kiểm tra trạng thái của mình.</p>
            </div>
          </div>
          <Link to="/huong-dan" className="text-link">
            Tìm hiểu cách đặt hàng <Icon name="arrow" size={17} />
          </Link>
        </div>
      </section>
    </>
  );
}
