import { Route, Routes } from 'react-router';
import { RequireAuth, RequireRole } from './auth/require-auth.tsx';
import { canChangeOwnPassword, canManageBranches, canManageUsers } from './auth/permissions.ts';
import { AppLayout } from './layout/app-shell.tsx';
import { BranchesPage } from './pages/branches-page.tsx';
import { ChangePasswordPage } from './pages/change-password-page.tsx';
import { HomePage } from './pages/home-page.tsx';
import { LoginPage } from './pages/login-page.tsx';
import { NotFoundPage } from './pages/not-found-page.tsx';
import { UsersPage } from './pages/users-page.tsx';

/** Đường dẫn và quyền vào từng trang. Quyền thật vẫn do server kiểm; ở đây chỉ để không hiện nhầm trang. */
export function App() {
  return (
    <Routes>
      <Route path="/dang-nhap" element={<LoginPage />} />
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
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
