import { Alert, Button, Center, Loader, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ForbiddenPage } from '../pages/forbidden-page.tsx';
import { ActiveBranchProvider } from './active-branch.tsx';
import { useSession } from './session-context.tsx';

const FullPageLoader = () => (
  <Center h="100vh">
    <Loader />
  </Center>
);

/**
 * Chặn mọi trang cần đăng nhập. Chưa đăng nhập → về trang đăng nhập, kèm trang đang xem trong `state.from`
 * để đăng nhập xong quay lại đúng chỗ. Chưa biết thông tin người dùng thì chưa hiện gì.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, me, meError, retryRestore, reloadMe } = useSession();
  const location = useLocation();

  if (status === 'loading') {
    return <FullPageLoader />;
  }
  if (status === 'unavailable') {
    return (
      <Center h="100vh" p="md">
        <Stack align="center">
          <Alert color="red" title="Không kết nối được máy chủ">
            Không thể khôi phục phiên đăng nhập. Hãy kiểm tra mạng rồi thử lại.
          </Alert>
          <Button onClick={retryRestore}>Thử lại</Button>
        </Stack>
      </Center>
    );
  }
  if (status === 'anonymous') {
    return <Navigate to="/dang-nhap" replace state={{ from: location }} />;
  }
  if (meError) {
    return (
      <Center h="100vh" p="md">
        <Stack align="center">
          <Text>Không tải được thông tin tài khoản.</Text>
          <Button onClick={reloadMe}>Thử lại</Button>
        </Stack>
      </Center>
    );
  }
  if (me === undefined) {
    return <FullPageLoader />;
  }
  return <ActiveBranchProvider>{children}</ActiveBranchProvider>;
}

/**
 * Trang chỉ cho một số vai trò. Không đủ quyền thì hiện "Không có quyền" và KHÔNG dựng trang con,
 * nên trang con không gọi API nào và không lộ dữ liệu.
 */
export function RequireRole({
  allow,
  children,
}: {
  allow: (branches: NonNullable<ReturnType<typeof useSession>['me']>['branches']) => boolean;
  children?: ReactNode;
}) {
  const { me } = useSession();
  if (me === undefined || !allow(me.branches)) {
    return <ForbiddenPage />;
  }
  return children ?? <Outlet />;
}
