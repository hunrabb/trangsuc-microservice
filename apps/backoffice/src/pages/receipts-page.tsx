import {
  Badge,
  Button,
  Group,
  Pagination,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { describeError } from '../api/messages.ts';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { inventoryKeys } from '../api/inventory-queries.ts';
import { canManageReceipts } from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';
import { ErrorAlert } from '../components/error-alert.tsx';
import { PlusIcon } from '../components/icons.tsx';
import { BranchSwitcher, useWorkingBranch } from '../inventory/working-branch.tsx';
import { formatDateTime, RECEIPT_STATUS_LABELS } from '../inventory/format.ts';

const PAGE_SIZE = 20;
const ALL_STATUSES = 'all';

/**
 * Danh sách phiếu nhập của chi nhánh đang làm việc. Chỉ ADMIN chọn chi nhánh và tạo phiếu nháp; vào từng
 * phiếu (`receipt-detail-page.tsx`) để thêm chiếc và duyệt.
 */
export function ReceiptsPage() {
  const { me } = useSession();
  const { branchId } = useWorkingBranch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUSES);

  const receipts = useQuery({
    queryKey: [...inventoryKeys.receipts, 'list', branchId, statusFilter, page],
    queryFn: () =>
      inventoryApi.listReceipts({
        page,
        pageSize: PAGE_SIZE,
        branchId: branchId ?? '',
        ...(statusFilter === ALL_STATUSES ? {} : { status: statusFilter as 'DRAFT' | 'APPROVED' }),
      }),
    enabled: branchId !== null,
    placeholderData: keepPreviousData,
  });

  const createDraft = useMutation({
    mutationFn: () => inventoryApi.createReceipt(branchId ?? ''),
    onSuccess: async (receipt) => {
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.receipts });
      navigate(`/nhap-hang/${receipt.id}`);
    },
    onError: (error) => notifications.show({ color: 'red', message: describeError(error) }),
  });

  const canCreate = me !== undefined && canManageReceipts(me.branches);
  const totalPages = Math.max(1, Math.ceil((receipts.data?.total ?? 0) / PAGE_SIZE));

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Nhập hàng</Title>
        {canCreate && (
          <Button
            leftSection={<PlusIcon size={16} />}
            loading={createDraft.isPending}
            onClick={() => createDraft.mutate()}
          >
            Tạo phiếu nháp
          </Button>
        )}
      </Group>
      <Group align="flex-end">
        <BranchSwitcher />
        <Select
          label="Trạng thái"
          w={180}
          allowDeselect={false}
          value={statusFilter}
          data={[
            { value: ALL_STATUSES, label: 'Tất cả' },
            { value: 'DRAFT', label: RECEIPT_STATUS_LABELS.DRAFT },
            { value: 'APPROVED', label: RECEIPT_STATUS_LABELS.APPROVED },
          ]}
          onChange={(value) => {
            setStatusFilter(value ?? ALL_STATUSES);
            setPage(1);
          }}
        />
      </Group>
      {receipts.isError && (
        <ErrorAlert error={receipts.error} onReload={() => void receipts.refetch()} />
      )}
      <Paper withBorder radius="md" bg="white">
        <Table.ScrollContainer minWidth={560}>
          <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Mã phiếu</Table.Th>
                <Table.Th>Trạng thái</Table.Th>
                <Table.Th>Số chiếc</Table.Th>
                <Table.Th>Duyệt lúc</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {receipts.data?.items.map((receipt) => (
                <Table.Tr key={receipt.id}>
                  <Table.Td>
                    <Text component={Link} to={`/nhap-hang/${receipt.id}`} fw={500} c="indigo">
                      {receipt.code}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={receipt.status === 'APPROVED' ? 'green' : 'yellow'}>
                      {RECEIPT_STATUS_LABELS[receipt.status]}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{receipt.lines.length}</Table.Td>
                  <Table.Td>
                    {receipt.approvedAt === null ? '—' : formatDateTime(receipt.approvedAt)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      {receipts.data?.items.length === 0 && <Text c="dimmed">Chưa có phiếu nhập nào.</Text>}
      {totalPages > 1 && <Pagination total={totalPages} value={page} onChange={setPage} />}
    </Stack>
  );
}
