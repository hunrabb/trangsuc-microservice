import {
  Alert,
  Badge,
  Button,
  Group,
  Pagination,
  Paper,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ErrorAlert } from '../components/error-alert.tsx';
import { BranchSwitcher, useWorkingBranch } from '../inventory/working-branch.tsx';
import { formatDateTime } from '../inventory/format.ts';
import { buybackApi, type BuybackPage } from './api.ts';
import { STATUS } from './model.ts';

const PAGE_SIZE = 20;
export function BuybackListPage() {
  const { branchId } = useWorkingBranch();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const invalidRange = Boolean(from && to && from > to);
  const query = useQuery({
    queryKey: ['buybacks', 'list', branchId, page, status, from, to],
    queryFn: () =>
      buybackApi.list(branchId!, {
        page,
        pageSize: PAGE_SIZE,
        ...(status ? { status: status as keyof typeof STATUS } : {}),
        ...(from ? { from: new Date(`${from}T00:00:00+07:00`).toISOString() } : {}),
        ...(to ? { to: new Date(`${to}T23:59:59.999+07:00`).toISOString() } : {}),
      }),
    enabled: branchId !== null && !invalidRange,
  });
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Thu mua vàng cũ</Title>
        {branchId && (
          <Button component={Link} to="/thu-mua/moi">
            Tạo phiếu tiếp nhận
          </Button>
        )}
      </Group>
      <Group align="end">
        <BranchSwitcher />
        <Select
          label="Trạng thái"
          w={210}
          value={status}
          allowDeselect={false}
          data={[
            { value: '', label: 'Tất cả' },
            ...Object.entries(STATUS).map(([value, config]) => ({ value, label: config.label })),
          ]}
          onChange={(value) => {
            setStatus(value ?? '');
            setPage(1);
          }}
        />
        <TextInput
          type="date"
          label="Từ ngày tiếp nhận"
          value={from}
          onChange={(event) => {
            setFrom(event.currentTarget.value);
            setPage(1);
          }}
        />
        <TextInput
          type="date"
          label="Đến ngày tiếp nhận"
          value={to}
          onChange={(event) => {
            setTo(event.currentTarget.value);
            setPage(1);
          }}
        />
      </Group>
      {invalidRange && <Alert color="red">Ngày bắt đầu phải không sau ngày kết thúc.</Alert>}
      <BuybackResults
        branchId={branchId}
        data={query.data}
        pending={query.isPending}
        error={query.error}
        page={page}
        onPageChange={setPage}
        onReload={() => void query.refetch()}
      />
    </Stack>
  );
}

export function BuybackResults({
  branchId,
  data,
  pending,
  error,
  page,
  onPageChange,
  onReload,
}: {
  branchId: string | null;
  data?: BuybackPage;
  pending: boolean;
  error: unknown;
  page: number;
  onPageChange(page: number): void;
  onReload(): void;
}) {
  if (branchId === null) return <Text c="dimmed">Chọn chi nhánh để xem phiếu.</Text>;
  return (
    <Stack>
      {error !== null && error !== undefined && <ErrorAlert error={error} onReload={onReload} />}
      {pending && (
        <Stack>
          {[1, 2, 3].map((n) => (
            <Skeleton key={n} h={48} />
          ))}
        </Stack>
      )}
      {data && <BuybackListTable page={data} />}
      {data?.items.length === 0 && <Text c="dimmed">Chưa có phiếu thu mua phù hợp.</Text>}
      {data && data.total > PAGE_SIZE && (
        <Pagination
          value={page}
          onChange={onPageChange}
          total={Math.ceil(data.total / PAGE_SIZE)}
        />
      )}
    </Stack>
  );
}

export function BuybackListTable({ page }: { page: BuybackPage }) {
  return (
    <Paper withBorder radius="md">
      <Table.ScrollContainer minWidth={800}>
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Mã phiếu</Table.Th>
              <Table.Th>Khách hàng</Table.Th>
              <Table.Th>Số món</Table.Th>
              <Table.Th>Trạng thái</Table.Th>
              <Table.Th>Ngày tạo</Table.Th>
              <Table.Th>Người tiếp nhận</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {page.items.map((row) => (
              <Table.Tr key={row.id}>
                <Table.Td>
                  <Text fw={600}>{row.code}</Text>
                </Table.Td>
                <Table.Td>{row.customerName}</Table.Td>
                <Table.Td>{row.itemCount}</Table.Td>
                <Table.Td>
                  <Badge color={STATUS[row.status].color}>{STATUS[row.status].label}</Badge>
                </Table.Td>
                <Table.Td>{formatDateTime(row.receivedAt)}</Table.Td>
                <Table.Td>
                  <Text size="xs" title={row.createdBy}>
                    {row.createdBy.slice(0, 8)}…
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Button component={Link} to={`/thu-mua/${row.id}`} size="xs" variant="light">
                    Xem chi tiết
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}
