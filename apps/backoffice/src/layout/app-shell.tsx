import { AppShell, Burger, Group, Menu, NavLink, Select, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { describeError } from '../api/messages.ts';
import { useBranchLabel } from '../api/queries.ts';
import { useActiveBranch } from '../auth/active-branch.tsx';
import { canChangeOwnPassword, canManageBranches, canManageUsers } from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';

interface NavItem {
  to: string;
  label: string;
  visible: boolean;
}

/** Khung chung: thanh trên (chi nhánh đang làm việc, tài khoản) và thanh bên (menu theo vai trò từ `/me`). */
export function AppLayout() {
  const { me, logout, logoutAll } = useSession();
  const { branchIds, activeBranchId, setActiveBranchId } = useActiveBranch();
  const branchLabel = useBranchLabel();
  const [opened, { toggle, close }] = useDisclosure(false);
  const location = useLocation();
  const navigate = useNavigate();

  const branches = me?.branches ?? [];
  const items: NavItem[] = [
    { to: '/', label: 'Trang chủ', visible: true },
    { to: '/chi-nhanh', label: 'Chi nhánh', visible: canManageBranches(branches) },
    { to: '/nhan-vien', label: 'Nhân viên', visible: canManageUsers(branches) },
    { to: '/doi-mat-khau', label: 'Đổi mật khẩu', visible: canChangeOwnPassword(branches) },
  ];

  const leave = async (action: () => Promise<void>) => {
    try {
      await action();
      navigate('/dang-nhap', { replace: true, state: null });
    } catch (error) {
      notifications.show({ color: 'red', message: describeError(error) });
    }
  };

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Title order={4}>Quản lý trang sức</Title>
          </Group>
          <Group wrap="nowrap">
            {branchIds.length > 1 && activeBranchId !== null && (
              <Select
                aria-label="Chi nhánh đang làm việc"
                w={200}
                allowDeselect={false}
                value={activeBranchId}
                data={branchIds.map((id) => ({ value: id, label: branchLabel(id) }))}
                onChange={(value) => value !== null && setActiveBranchId(value)}
              />
            )}
            {branchIds.length === 1 && activeBranchId !== null && (
              <Text size="sm" visibleFrom="sm">
                {branchLabel(activeBranchId)}
              </Text>
            )}
            <Menu position="bottom-end">
              <Menu.Target>
                <Text component="button" type="button" size="sm" style={{ cursor: 'pointer' }}>
                  {me?.fullName ?? ''}
                </Text>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{me?.email}</Menu.Label>
                <Menu.Item onClick={() => void leave(logout)}>Đăng xuất</Menu.Item>
                <Menu.Item color="red" onClick={() => void leave(logoutAll)}>
                  Đăng xuất mọi thiết bị
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {items
          .filter((item) => item.visible)
          .map((item) => (
            <NavLink
              key={item.to}
              component={Link}
              to={item.to}
              label={item.label}
              active={
                item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
              }
              onClick={close}
            />
          ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
