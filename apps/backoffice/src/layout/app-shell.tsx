import {
  Avatar,
  AppShell,
  Badge,
  Burger,
  Group,
  Menu,
  NavLink,
  Select,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { describeError } from '../api/messages.ts';
import { useBranchLabel } from '../api/queries.ts';
import { useActiveBranch } from '../auth/active-branch.tsx';
import {
  canBranchStockAccess,
  canChangeOwnPassword,
  canManageBranches,
  canManageCatalog,
  canManageUsers,
  canUsePos,
  canViewReports,
  isAdmin,
} from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';
import {
  BoxIcon,
  ChecklistIcon,
  GemIcon,
  HomeIcon,
  KeyIcon,
  LogoutIcon,
  ReceiptIcon,
  StockIcon,
  StoreIcon,
  TagIcon,
  UsersIcon,
} from '../components/icons.tsx';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  visible: boolean;
}

/** Chữ cái đầu của họ tên, cho hình đại diện. */
const initialsOf = (fullName: string): string =>
  fullName
    .trim()
    .split(/\s+/)
    .slice(-2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

/**
 * Khung chung. Thanh trên: tên hệ thống, chi nhánh đang làm việc, menu tài khoản. Thanh bên: menu theo vai trò
 * lấy từ `/me`, mục đang mở được tô màu.
 */
export function AppLayout() {
  const { me, logout, logoutAll } = useSession();
  const { branchIds, activeBranchId, setActiveBranchId } = useActiveBranch();
  const branchLabel = useBranchLabel();
  const [opened, { toggle, close }] = useDisclosure(false);
  const location = useLocation();
  const navigate = useNavigate();

  const branches = me?.branches ?? [];
  const items: NavItem[] = [
    { to: '/', label: 'Trang chủ', icon: <HomeIcon />, visible: true },
    {
      to: '/chi-nhanh',
      label: 'Chi nhánh',
      icon: <StoreIcon />,
      visible: canManageBranches(branches),
    },
    {
      to: '/nhan-vien',
      label: 'Nhân viên',
      icon: <UsersIcon />,
      visible: canManageUsers(branches),
    },
    {
      to: '/gia-kim-loai',
      label: 'Giá kim loại',
      icon: <TagIcon />,
      visible: canManageCatalog(branches),
    },
    {
      to: '/san-pham',
      label: 'Sản phẩm',
      icon: <BoxIcon />,
      visible: canManageCatalog(branches),
    },
    {
      to: '/nhap-hang',
      label: 'Nhập hàng',
      icon: <ReceiptIcon />,
      visible: canBranchStockAccess(branches),
    },
    {
      to: '/ban-tai-quay',
      label: 'Bán tại quầy',
      icon: <ReceiptIcon />,
      visible: canUsePos(branches),
    },
    {
      to: '/ton-kho',
      label: 'Tồn kho',
      icon: <StockIcon />,
      visible: canBranchStockAccess(branches),
    },
    {
      to: '/kiem-ke',
      label: 'Kiểm kê',
      icon: <ChecklistIcon />,
      visible: canBranchStockAccess(branches),
    },
    {
      to: '/doi-mat-khau',
      label: 'Đổi mật khẩu',
      icon: <KeyIcon />,
      visible: canChangeOwnPassword(branches),
    },
    {
      to: '/thu-loi',
      label: 'Thư lỗi DLQ',
      icon: <ChecklistIcon />,
      visible: isAdmin(branches),
    },
    {
      to: '/bao-cao',
      label: 'Báo cáo',
      icon: <ChecklistIcon />,
      visible: canViewReports(branches),
    },
  ];

  const leave = async (action: () => Promise<void>) => {
    try {
      await action();
      navigate('/dang-nhap', { replace: true, state: null });
    } catch (error) {
      notifications.show({ color: 'red', message: describeError(error) });
    }
  };

  const fullName = me?.fullName ?? '';

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 250, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="lg"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap" gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <ThemeIcon
              size={34}
              radius="md"
              variant="gradient"
              gradient={{ from: 'indigo', to: 'violet' }}
            >
              <GemIcon size={20} />
            </ThemeIcon>
            <Title order={4}>Quản lý trang sức</Title>
          </Group>
          <Group wrap="nowrap" gap="md">
            {branchIds.length > 1 && activeBranchId !== null && (
              <Select
                aria-label="Chi nhánh đang làm việc"
                w={220}
                allowDeselect={false}
                leftSection={<StoreIcon size={16} />}
                value={activeBranchId}
                data={branchIds.map((id) => ({ value: id, label: branchLabel(id) }))}
                onChange={(value) => value !== null && setActiveBranchId(value)}
              />
            )}
            {branchIds.length === 1 && activeBranchId !== null && (
              <Badge
                size="lg"
                variant="light"
                leftSection={<StoreIcon size={14} />}
                visibleFrom="sm"
              >
                {branchLabel(activeBranchId)}
              </Badge>
            )}
            <Menu position="bottom-end" width={240} shadow="md">
              <Menu.Target>
                <UnstyledButton aria-label="Menu tài khoản">
                  <Group gap="xs" wrap="nowrap">
                    <Avatar color="indigo" radius="xl" size={34}>
                      {initialsOf(fullName)}
                    </Avatar>
                    <Text size="sm" fw={500} visibleFrom="sm">
                      {fullName}
                    </Text>
                  </Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  <Text size="sm" fw={600} c="dark" truncate>
                    {fullName}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {me?.email}
                  </Text>
                </Menu.Label>
                <Menu.Divider />
                {isAdmin(branches) && (
                  <Menu.Item
                    leftSection={<KeyIcon size={16} />}
                    component={Link}
                    to="/doi-mat-khau"
                  >
                    Đổi mật khẩu
                  </Menu.Item>
                )}
                <Menu.Item
                  leftSection={<LogoutIcon size={16} />}
                  onClick={() => void leave(logout)}
                >
                  Đăng xuất
                </Menu.Item>
                <Menu.Item
                  color="red"
                  leftSection={<LogoutIcon size={16} />}
                  onClick={() => void leave(logoutAll)}
                >
                  Đăng xuất mọi thiết bị
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="sm">
        {items
          .filter((item) => item.visible)
          .map((item) => (
            <NavLink
              key={item.to}
              component={Link}
              to={item.to}
              label={item.label}
              leftSection={item.icon}
              variant="light"
              fw={500}
              style={{ borderRadius: 'var(--mantine-radius-md)' }}
              active={
                item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
              }
              onClick={close}
            />
          ))}
      </AppShell.Navbar>
      <AppShell.Main bg="gray.0">
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
