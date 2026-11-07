import type { User } from '@jewelry/contracts';
import {
  Badge,
  Button,
  Group,
  Menu,
  Pagination,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { authApi } from '../api/endpoints.ts';
import { describeError } from '../api/messages.ts';
import { queryKeys, useBranchLabel } from '../api/queries.ts';
import { useActiveBranch } from '../auth/active-branch.tsx';
import {
  canAssignRoles,
  canLockUser,
  canManageUser,
  canResetPassword,
  isAdmin,
  managedBranchIds,
  ROLE_LABELS,
} from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { ErrorAlert } from '../components/error-alert.tsx';
import {
  AssignRolesModal,
  CreateUserModal,
  EditUserModal,
  ResetPasswordModal,
  useAssignableBranches,
} from './users-dialogs.tsx';

const PAGE_SIZE = 20;
const ALL = 'all';

type Dialog =
  { kind: 'create' } | { kind: 'edit' | 'assign' | 'reset' | 'lock' | 'unlink'; user: User };

/**
 * Danh sách nhân viên. ADMIN xem mọi chi nhánh (hoặc lọc); MANAGER chỉ xem chi nhánh mình quản lý, và server
 * bắt buộc có `branchId`. Nút nào cũng chỉ hiện khi người dùng làm được (`auth/permissions.ts`).
 */
export function UsersPage() {
  const { me } = useSession();
  const { activeBranchId } = useActiveBranch();
  const branchLabel = useBranchLabel();
  const filterBranches = useAssignableBranches();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const admin = me !== undefined && isAdmin(me.branches);
  const managed = me === undefined ? [] : managedBranchIds(me.branches);
  // ADMIN: mặc định mọi chi nhánh. MANAGER: bắt buộc một chi nhánh mình quản lý, ưu tiên chi nhánh đang làm.
  const branchId = admin
    ? filter === null || filter === ALL
      ? undefined
      : filter
    : managed.includes(filter ?? '')
      ? (filter ?? undefined)
      : managed.includes(activeBranchId ?? '')
        ? (activeBranchId ?? undefined)
        : managed[0];

  const users = useQuery({
    queryKey: [...queryKeys.users, branchId ?? ALL, page],
    queryFn: () => authApi.listUsers({ page, pageSize: PAGE_SIZE, branchId }),
    placeholderData: keepPreviousData,
    enabled: me !== undefined,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.users });

  const act = useMutation({
    mutationFn: ({ kind, user }: { kind: 'lock' | 'unlock' | 'unlink'; user: User }) =>
      kind === 'lock'
        ? authApi.lockUser(user.id)
        : kind === 'unlock'
          ? authApi.unlockUser(user.id)
          : authApi.unlinkGoogle(user.id),
    onSuccess: async (_user, { kind }) => {
      setDialog(null);
      await refresh();
      notifications.show({
        color: 'green',
        message:
          kind === 'lock'
            ? 'Đã khoá tài khoản.'
            : kind === 'unlock'
              ? 'Đã mở khoá tài khoản.'
              : 'Đã gỡ liên kết Google.',
      });
    },
    onError: (error) => {
      setDialog(null);
      void refresh();
      notifications.show({ color: 'red', message: describeError(error) });
    },
  });

  if (me === undefined) {
    return null;
  }
  const totalPages = Math.max(1, Math.ceil((users.data?.total ?? 0) / PAGE_SIZE));
  const target = dialog !== null && dialog.kind !== 'create' ? dialog.user : null;
  const filterValue = admin ? (filter ?? ALL) : (branchId ?? null);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Nhân viên</Title>
        <Button onClick={() => setDialog({ kind: 'create' })}>Thêm nhân viên</Button>
      </Group>
      <Select
        label="Chi nhánh"
        w={260}
        allowDeselect={false}
        value={filterValue}
        data={
          admin ? [{ value: ALL, label: 'Tất cả chi nhánh' }, ...filterBranches] : filterBranches
        }
        onChange={(value) => {
          setFilter(value);
          setPage(1);
        }}
      />
      {users.isError && <ErrorAlert error={users.error} onReload={() => void users.refetch()} />}
      <Table.ScrollContainer minWidth={760}>
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Nhân viên</Table.Th>
              <Table.Th>Vai trò</Table.Th>
              <Table.Th>Trạng thái</Table.Th>
              <Table.Th>Google</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.data?.items.map((user) => (
              <Table.Tr key={user.id}>
                <Table.Td>
                  <Text size="sm" fw={500}>
                    {user.fullName}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {user.email}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {user.branches.map(({ role, branchId: id }) => (
                      <Badge key={`${role}:${id}`} variant="light">
                        {role === 'ADMIN'
                          ? ROLE_LABELS.ADMIN
                          : `${ROLE_LABELS[role]} · ${branchLabel(id)}`}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Badge color={user.status === 'ACTIVE' ? 'green' : 'red'}>
                    {user.status === 'ACTIVE' ? 'Hoạt động' : 'Đã khoá'}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Badge color={user.googleLinked ? 'green' : 'gray'} variant="outline">
                    {user.googleLinked ? 'Đã liên kết' : 'Chưa'}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <RowActions
                    user={user}
                    onChoose={(kind) => {
                      if (kind === 'unlock') {
                        act.mutate({ kind, user });
                      } else {
                        setDialog({ kind, user });
                      }
                    }}
                  />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {users.data?.items.length === 0 && <Text c="dimmed">Không có nhân viên nào.</Text>}
      {totalPages > 1 && <Pagination total={totalPages} value={page} onChange={setPage} />}

      {dialog?.kind === 'create' && <CreateUserModal onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && (
        <EditUserModal
          key={`${dialog.user.id}:${dialog.user.version}`}
          user={dialog.user}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'assign' && (
        <AssignRolesModal key={dialog.user.id} user={dialog.user} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'reset' && (
        <ResetPasswordModal
          key={dialog.user.id}
          user={dialog.user}
          onClose={() => setDialog(null)}
        />
      )}
      <ConfirmDialog
        opened={dialog?.kind === 'lock'}
        title="Khoá tài khoản"
        confirmLabel="Khoá"
        loading={act.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => target !== null && act.mutate({ kind: 'lock', user: target })}
      >
        {target?.email} sẽ bị đăng xuất khỏi mọi thiết bị và không đăng nhập được cho tới khi mở
        khoá. Phiên đang mở có thể còn dùng được tối đa 15 phút.
      </ConfirmDialog>
      <ConfirmDialog
        opened={dialog?.kind === 'unlink'}
        title="Gỡ liên kết Google"
        confirmLabel="Gỡ liên kết"
        loading={act.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => target !== null && act.mutate({ kind: 'unlink', user: target })}
      >
        {target?.email} sẽ bị đăng xuất khỏi mọi thiết bị và phải đăng nhập Google lại để liên kết.
      </ConfirmDialog>
    </Stack>
  );

  /** Menu thao tác của một dòng, chỉ gồm những việc người dùng được làm với người này. */
  function RowActions({
    user,
    onChoose,
  }: {
    user: User;
    onChoose(kind: 'edit' | 'assign' | 'reset' | 'lock' | 'unlock' | 'unlink'): void;
  }) {
    const actor = { id: me?.id ?? '', branches: me?.branches ?? [] };
    const manageable = canManageUser(actor, user);
    const items = [
      manageable && { kind: 'edit' as const, label: 'Sửa thông tin' },
      canAssignRoles(actor.branches) && { kind: 'assign' as const, label: 'Gán vai trò' },
      user.status === 'ACTIVE'
        ? canLockUser(actor, user) && {
            kind: 'lock' as const,
            label: 'Khoá tài khoản',
            danger: true,
          }
        : manageable && { kind: 'unlock' as const, label: 'Mở khoá tài khoản' },
      manageable &&
        user.googleLinked && { kind: 'unlink' as const, label: 'Gỡ liên kết Google', danger: true },
      canResetPassword(actor, user) && {
        kind: 'reset' as const,
        label: 'Đặt lại mật khẩu',
        danger: true,
      },
    ].filter((item) => item !== false);
    if (items.length === 0) {
      return null;
    }
    return (
      <Group justify="flex-end">
        <Menu position="bottom-end">
          <Menu.Target>
            <Button size="compact-sm" variant="default">
              Thao tác
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {items.map((item) => (
              <Menu.Item
                key={item.kind}
                color={'danger' in item ? 'red' : undefined}
                onClick={() => onChoose(item.kind)}
              >
                {item.label}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>
    );
  }
}
