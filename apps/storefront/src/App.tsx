import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { StoreProvider } from './state/store.tsx';
import { Layout } from './components/layout.tsx';
import { StatePanel } from './components/ui.tsx';
import { HomePage } from './pages/home.tsx';
import { CatalogPage } from './pages/catalog.tsx';
import { ProductPage } from './pages/product.tsx';
import { CartPage } from './pages/cart.tsx';
import { CheckoutPage } from './pages/checkout.tsx';
import { OrdersPage } from './pages/orders.tsx';
import { GuidePage } from './pages/guide.tsx';
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: false },
    mutations: { retry: false },
  },
});
export function StorefrontRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="bo-suu-tap" element={<CatalogPage />} />
        <Route path="san-pham/:productId" element={<ProductPage />} />
        <Route path="gio-hang" element={<CartPage />} />
        <Route path="dat-hang" element={<CheckoutPage />} />
        <Route path="don-hang" element={<OrdersPage />} />
        <Route path="don-hang/:orderId" element={<OrdersPage />} />
        <Route path="huong-dan" element={<GuidePage />} />
        <Route
          path="*"
          element={
            <div className="container">
              <StatePanel
                title="Trang này chưa có trong bộ sưu tập"
                action={
                  <Link className="button button-dark" to="/bo-suu-tap">
                    Khám phá bộ sưu tập
                  </Link>
                }
              />
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <StoreProvider>
        <BrowserRouter>
          <StorefrontRoutes />
        </BrowserRouter>
      </StoreProvider>
    </QueryClientProvider>
  );
}
