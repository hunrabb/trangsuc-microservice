import { Route, Routes } from 'react-router';
import {
  canBranchStockAccess,
  canChangeOwnPassword,
  canManageBranches,
  canManageCatalog,
  canManageUsers,
  canUsePos,
} from './auth/permissions.ts';
import { RequireAuth, RequireRole } from './auth/require-auth.tsx';
import { WorkingBranchLayout } from './inventory/working-branch.tsx';
import { AppLayout } from './layout/app-shell.tsx';
import { BranchesPage } from './pages/branches-page.tsx';
import { ChangePasswordPage } from './pages/change-password-page.tsx';
import { HomePage } from './pages/home-page.tsx';
import { ItemLabelPage } from './pages/item-label-page.tsx';
import { LoginPage } from './pages/login-page.tsx';
import { MetalsPage } from './pages/metals-page.tsx';
import { NotFoundPage } from './pages/not-found-page.tsx';
import { ProductsPage } from './pages/products-page.tsx';
import { PosPage } from './pages/pos-page.tsx';
import { ReceiptDetailPage } from './pages/receipt-detail-page.tsx';
import { ReceiptsPage } from './pages/receipts-page.tsx';
import { StockCountDetailPage } from './pages/stock-count-detail-page.tsx';
import { StockCountsPage } from './pages/stock-counts-page.tsx';
import { StockPage } from './pages/stock-page.tsx';
import { UsersPage } from './pages/users-page.tsx';

/** Đường dẫn và quyền vào từng trang. Quyền thật vẫn do server kiểm; ở đây chỉ để không hiện nhầm trang. */
export function App() {
  return (
    <Routes>
      <Route path="/dang-nhap" element={<LoginPage />} />
      {/* Trang in tem: cần đăng nhập nhưng không có khung menu, để chỉ tem được in. */}
      <Route
        path="/in-tem/:tagCode"
        element={
          <RequireAuth>
            <RequireRole allow={canBranchStockAccess}>
              <ItemLabelPage />
            </RequireRole>
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route element={<RequireRole allow={canManageBranches} />}>
          <Route path="/chi-nhanh" element={<BranchesPage />} />
        </Route>
        <Route element={<RequireRole allow={canManageUsers} />}>
          <Route path="/nhan-vien" element={<UsersPage />} />
        </Route>
        <Route element={<RequireRole allow={canChangeOwnPassword} />}>
          <Route path="/doi-mat-khau" element={<ChangePasswordPage />} />
        </Route>
        <Route element={<RequireRole allow={canManageCatalog} />}>
          <Route path="/gia-kim-loai" element={<MetalsPage />} />
          <Route path="/san-pham" element={<ProductsPage />} />
        </Route>
        <Route element={<RequireRole allow={canBranchStockAccess} />}>
          <Route element={<WorkingBranchLayout />}>
            <Route path="/nhap-hang" element={<ReceiptsPage />} />
            <Route path="/nhap-hang/:receiptId" element={<ReceiptDetailPage />} />
            <Route path="/ton-kho" element={<StockPage />} />
            <Route path="/kiem-ke" element={<StockCountsPage />} />
            <Route path="/kiem-ke/:stockCountId" element={<StockCountDetailPage />} />
          </Route>
        </Route>
        <Route element={<RequireRole allow={canUsePos} />}>
          <Route element={<WorkingBranchLayout />}>
            <Route path="/ban-tai-quay" element={<PosPage />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
