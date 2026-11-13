import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useStore } from '../state/store.tsx';
import { Icon } from './ui.tsx';
export const STORE_NAME = import.meta.env?.VITE_STORE_NAME?.trim() || 'Trang sức';
export function Layout() {
  const location = useLocation();
  const metalKind = new URLSearchParams(location.search).get('metalKind');
  const inCatalog = location.pathname === '/bo-suu-tap';
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { cart, notice, storageAvailable, announce } = useStore();
  const count = cart.reduce((n, item) => n + item.quantity, 0);
  useEffect(() => {
    const page = location.pathname.startsWith('/san-pham/')
      ? 'Chi tiết sản phẩm'
      : ({
          '/': 'Bộ sưu tập trực tuyến',
          '/bo-suu-tap':
            metalKind === 'GOLD'
              ? 'Trang sức vàng'
              : metalKind === 'SILVER'
                ? 'Trang sức bạc'
                : 'Bộ sưu tập',
          '/gio-hang': 'Giỏ hàng',
          '/dat-hang': 'Đặt hàng',
          '/huong-dan': 'Hướng dẫn đặt hàng',
        }[location.pathname] ?? 'Theo dõi đơn');
    document.title = `${page} · ${STORE_NAME}`;
    setMenu(false);
    document.getElementById('main-content')?.focus({ preventScroll: true });
    const anchor = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (anchor) anchor.scrollIntoView();
    else window.scrollTo({ top: 0, behavior: 'instant' });
  }, [location.pathname, location.search, location.hash, metalKind]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => announce(''), 12_000);
    return () => clearTimeout(timer);
  }, [notice, announce]);
  const closeMenu = () => setMenu(false);
  return (
    <div className="site-wrapper">
      <a href="#main-content" className="skip-link">
        Đến nội dung chính
      </a>
      <div className="announcement-bar">THE JEWELRY EDIT — Vẻ đẹp mang dấu ấn riêng</div>
      <header
        className="site-header"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setMenu(false);
            menuButton.current?.focus();
          }
        }}
      >
        <div className="header-inner">
          <button
            ref={menuButton}
            className="icon-button mobile-menu-button"
            aria-label={menu ? 'Đóng menu' : 'Mở menu'}
            aria-expanded={menu}
            aria-controls="main-nav"
            onClick={() => setMenu(!menu)}
          >
            <Icon name={menu ? 'close' : 'menu'} />
          </button>
          <Link to="/" className="wordmark" onClick={closeMenu}>
            <Icon name="diamond" size={27} />
            <span>
              {STORE_NAME}
              <small>JEWELRY COLLECTION</small>
            </span>
          </Link>
          <nav
            id="main-nav"
            aria-label="Điều hướng chính"
            className={`main-nav ${menu ? 'is-open' : ''}`}
          >
            <NavLink to="/" end onClick={closeMenu}>
              Khám phá
            </NavLink>
            <Link
              to="/bo-suu-tap"
              aria-current={inCatalog && !metalKind ? 'page' : undefined}
              onClick={closeMenu}
            >
              Bộ sưu tập
            </Link>
            <Link
              to="/bo-suu-tap?metalKind=GOLD"
              aria-current={inCatalog && metalKind === 'GOLD' ? 'page' : undefined}
              onClick={closeMenu}
            >
              Trang sức vàng
            </Link>
            <Link
              to="/bo-suu-tap?metalKind=SILVER"
              aria-current={inCatalog && metalKind === 'SILVER' ? 'page' : undefined}
              onClick={closeMenu}
            >
              Trang sức bạc
            </Link>
            <NavLink to="/tai-khoan/don-hang" className="mobile-order-link" onClick={closeMenu}>
              Tài khoản của tôi
            </NavLink>
          </nav>
          <div className="header-actions">
            <Link
              to="/bo-suu-tap"
              className="icon-button header-search"
              aria-label="Tìm kiếm sản phẩm"
              onClick={closeMenu}
            >
              <Icon name="search" />
            </Link>
            <NavLink to="/tai-khoan/don-hang" className="desktop-order-link" onClick={closeMenu}>
              Tài khoản của tôi
            </NavLink>
            <Link
              to="/gio-hang"
              className="bag-link icon-button"
              aria-label={`Giỏ hàng, ${count} sản phẩm`}
              onClick={closeMenu}
            >
              <Icon name="bag" />
              {count > 0 && <span className="bag-count">{count}</span>}
            </Link>
          </div>
        </div>
      </header>
      {!storageAvailable && (
        <div className="storage-warning" role="status">
          Giỏ đang được giữ trong phiên này. Trình duyệt chưa cho phép lưu giỏ sau khi đóng trang.
        </div>
      )}
      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
      <div className="cart-announcement" role="status" aria-live="polite" key={notice}>
        {notice && (
          <>
            <Icon name="check" />
            {notice}
            <Link to="/gio-hang" onClick={() => announce('')}>
              Xem giỏ <Icon name="arrow" size={15} />
            </Link>
            <button
              className="icon-button"
              aria-label="Đóng thông báo"
              onClick={() => announce('')}
            >
              <Icon name="close" size={18} />
            </button>
          </>
        )}
      </div>
      <footer className="site-footer">
        <div className="container footer-grid">
          <div>
            <Link className="footer-wordmark" to="/">
              {STORE_NAME}
            </Link>
            <p>
              Trang sức cho những khoảnh khắc
              <br />
              bạn muốn lưu giữ.
            </p>
          </div>
          <div>
            <h2>Khám phá</h2>
            <Link to="/bo-suu-tap">Bộ sưu tập</Link>
            <Link to="/bo-suu-tap?metalKind=GOLD">Trang sức vàng</Link>
            <Link to="/bo-suu-tap?metalKind=SILVER">Trang sức bạc</Link>
          </div>
          <div>
            <h2>Đồng hành cùng bạn</h2>
            <Link to="/huong-dan">Mua hàng & thanh toán</Link>
            <Link to="/tai-khoan/don-hang">Theo dõi đơn hàng</Link>
            <Link to="/gio-hang">Giỏ hàng của bạn</Link>
          </div>
          <div className="footer-note">
            <Icon name="diamond" size={30} />
            <p>
              Lựa chọn theo phong cách.
              <br />
              Đặt hàng theo cách rõ ràng.
            </p>
            <span>Giá và sản phẩm được kiểm tra khi đặt hàng.</span>
          </div>
        </div>
        <div className="container footer-bottom">
          <span>{STORE_NAME} · Bộ sưu tập trực tuyến</span>
          <Link to="/huong-dan#quyen-tra-cuu">Quyền tra cứu & thông tin đơn</Link>
        </div>
      </footer>
    </div>
  );
}
