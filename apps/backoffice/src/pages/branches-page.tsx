import type { Branch } from '@jewelry/contracts';
import {
  Badge,
  Button,
  Group,
  Modal,
  Pagination,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { authApi } from '../api/endpoints.ts';
import { describeError } from '../api/messages.ts';
import { queryKeys, useBranchPage } from '../api/queries.ts';
import { boundFieldErrors, ErrorAlert } from '../components/error-alert.tsx';
import { PlusIcon } from '../components/icons.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';

const PAGE_SIZE = 20;
const FORM_FIELDS = ['code', 'name', 'address', 'phone'];

/** Danh sách chi nhánh (chỉ ADMIN): tạo, sửa, ngừng hoạt động, mở lại. */
export function BranchesPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  const [toggling, setToggling] = useState<Branch | null>(null);
  const branches = useBranchPage(page, PAGE_SIZE);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.branches });

  const toggle = useMutation({
    mutationFn: (branch: Branch) =>
      branch.isActive ? authApi.deactivateBranch(branch.id) : authApi.activateBranch(branch.id),
    onSuccess: async (branch) => {
      setToggling(null);
      await refresh();
      notifications.show({
        color: 'green',
        message: branch.isActive ? 'Đã mở lại chi nhánh.' : 'Đã ngừng hoạt động chi nhánh.',
      });
    },
    onError: (error) => {
      setToggling(null);
      void refresh();
      notifications.show({ color: 'red', message: describeError(error) });
    },
  });

  const totalPages = Math.max(1, Math.ceil((branches.data?.total ?? 0) / PAGE_SIZE));

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Chi nhánh</Title>
        <Button leftSection={<PlusIcon size={16} />} onClick={() => setEditing('new')}>
          Thêm chi nhánh
        </Button>
      </Group>
      {branches.isError && (
        <ErrorAlert error={branches.error} onReload={() => void branches.refetch()} />
      )}
      <Paper withBorder radius="md" bg="white">
        <Table.ScrollContainer minWidth={640}>
          <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Mã</Table.Th>
                <Table.Th>Tên</Table.Th>
                <Table.Th>Địa chỉ</Table.Th>
                <Table.Th>Điện thoại</Table.Th>
                <Table.Th>Trạng thái</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {branches.data?.items.map((branch) => (
                <Table.Tr key={branch.id}>
                  <Table.Td>{branch.code}</Table.Td>
                  <Table.Td>{branch.name}</Table.Td>
                  <Table.Td>{branch.address ?? ''}</Table.Td>
                  <Table.Td>{branch.phone ?? ''}</Table.Td>
                  <Table.Td>
                    <Badge color={branch.isActive ? 'green' : 'gray'}>
                      {branch.isActive ? 'Đang hoạt động' : 'Đã ngừng'}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" justify="flex-end" wrap="nowrap">
                      <Button
                        size="compact-sm"
                        variant="default"
                        onClick={() => setEditing(branch)}
                      >
                        Sửa
                      </Button>
                      {branch.isActive ? (
                        <Button
                          size="compact-sm"
                          color="red"
                          variant="light"
                          onClick={() => setToggling(branch)}
                        >
                          Ngừng hoạt động
                        </Button>
                      ) : (
                        <Button
                          size="compact-sm"
                          variant="light"
                          loading={toggle.isPending && toggle.variables.id === branch.id}
                          onClick={() => toggle.mutate(branch)}
                        >
                          Mở lại
                        </Button>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      {branches.data?.items.length === 0 && <Text c="dimmed">Chưa có chi nhánh nào.</Text>}
      {totalPages > 1 && <Pagination total={totalPages} value={page} onChange={setPage} />}

      {editing !== null && (
        <BranchFormModal
          key={editing === 'new' ? 'new' : `${editing.id}:${editing.version}`}
          branch={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        opened={toggling !== null}
        title="Ngừng hoạt động chi nhánh"
        confirmLabel="Ngừng hoạt động"
        loading={toggle.isPending}
        onCancel={() => setToggling(null)}
        onConfirm={() => toggling !== null && toggle.mutate(toggling)}
      >
        Nhân viên chỉ có vai trò ở chi nhánh “{toggling?.name}” sẽ không đăng nhập được nữa, và vai
        trò ở đây không còn hiệu lực ở lần đăng nhập kế tiếp. Có thể mở lại sau.
      </ConfirmDialog>
    </Stack>
  );
}

interface BranchValues {
  code: string;
  name: string;
  address: string;
  phone: string;
}

/** Tạo (`branch = null`) hoặc sửa chi nhánh. Sửa gửi kèm `version` để phát hiện người khác vừa sửa. */
function BranchFormModal({
  branch,
  onClose,
  onSaved,
}: {
  branch: Branch | null;
  onClose(): void;
  onSaved(): Promise<unknown>;
}) {
  const form = useForm<BranchValues>({
    initialValues: {
      code: branch?.code ?? '',
      name: branch?.name ?? '',
      address: branch?.address ?? '',
      phone: branch?.phone ?? '',
    },
    validate: {
      code: (value) => (branch === null && value.trim() === '' ? 'Nhập mã chi nhánh' : null),
      name: (value) => (value.trim() === '' ? 'Nhập tên chi nhánh' : null),
    },
  });

  const save = useMutation({
    mutationFn: (values: BranchValues) => {
      const address = values.address.trim();
      const phone = values.phone.trim();
      if (branch === null) {
        return authApi.createBranch({
          code: values.code.trim(),
          name: values.name.trim(),
          ...(address === '' ? {} : { address }),
          ...(phone === '' ? {} : { phone }),
        });
      }
      return authApi.updateBranch(branch.id, {
        version: branch.version,
        name: values.name.trim(),
        address: address === '' ? null : address,
        phone: phone === '' ? null : phone,
      });
    },
    onSuccess: async () => {
      await onSaved();
      notifications.show({
        color: 'green',
        message: branch === null ? 'Đã tạo chi nhánh.' : 'Đã lưu chi nhánh.',
      });
      onClose();
    },
    onError: (error) => form.setErrors(boundFieldErrors(error, FORM_FIELDS)),
  });

  const reload = () => {
    void onSaved();
    onClose();
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={branch === null ? 'Thêm chi nhánh' : 'Sửa chi nhánh'}
      centered
    >
      <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
        <ErrorAlert error={save.error} onReload={reload} boundFields={FORM_FIELDS} />
        <Stack>
          {branch === null && (
            <TextInput label="Mã chi nhánh" withAsterisk {...form.getInputProps('code')} />
          )}
          <TextInput label="Tên chi nhánh" withAsterisk {...form.getInputProps('name')} />
          <TextInput label="Địa chỉ" {...form.getInputProps('address')} />
          <TextInput label="Điện thoại" {...form.getInputProps('phone')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" loading={save.isPending}>
              Lưu
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
