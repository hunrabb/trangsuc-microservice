import type { ItemWithPrice } from '@jewelry/contracts';
import {
  Badge,
  Button,
  Card,
  Group,
  Pagination,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { inventoryKeys, useAllVariants } from '../api/inventory-queries.ts';
import { ErrorAlert } from '../components/error-alert.tsx';
import { PrinterIcon } from '../components/icons.tsx';
import { formatMoney, formatWeight, ITEM_STATUS_LABELS } from '../inventory/format.ts';
import { BranchSwitcher, useWorkingBranch } from '../inventory/working-branch.tsx';

const PAGE_SIZE = 20;
const ALL = 'all';

const STATUS_COLORS = { IN_STOCK: 'green', RESERVED: 'yellow', SOLD: 'gray' } as const;

/** Liên kết mở trang in tem ở thẻ mới (trang in riêng, không có khung menu). */
export function PrintLabelButton({ tagCode }: { tagCode: string }) {
  return (
    <Button
      component="a"
      href={`/in-tem/${encodeURIComponent(tagCode)}`}
      target="_blank"
      rel="noopener"
      size="compact-sm"
      variant="light"
      leftSection={<PrinterIcon size={14} />}
    >
      In tem
    </Button>
  );
}

/**
 * Tồn kho của chi nhánh đang làm việc: danh sách từng chiếc (lọc theo biến thể và trạng thái, phân trang) và ô
 * tra cứu theo mã tem kèm giá hiện tại. Giá vốn chỉ MANAGER và ADMIN thấy (server trả rỗng cho người khác).
 */
export function StockPage() {
  const { branchId } = useWorkingBranch();
  const variants = useAllVariants();
  const [page, setPage] = useState(1);
  const [variantFilter, setVariantFilter] = useState(ALL);
  const [statusFilter, setStatusFilter] = useState(ALL);

  const items = useQuery({
    queryKey: [...inventoryKeys.items, 'list', branchId, variantFilter, statusFilter, page],
    queryFn: () =>
      inventoryApi.listItems({
        page,
        pageSize: PAGE_SIZE,
        branchId: branchId ?? '',
        ...(variantFilter === ALL ? {} : { variantId: variantFilter }),
        ...(statusFilter === ALL
          ? {}
          : { status: statusFilter as keyof typeof ITEM_STATUS_LABELS }),
      }),
    enabled: branchId !== null,
    placeholderData: keepPreviousData,
  });
  const totalPages = Math.max(1, Math.ceil((items.data?.total ?? 0) / PAGE_SIZE));

  return (
    <Stack>
      <Title order={2}>Tồn kho</Title>
      <TagLookup />
      <Group align="flex-end">
        <BranchSwitcher />
        <Select
          label="Biến thể"
          w={260}
          searchable
          allowDeselect={false}
          value={variantFilter}
          data={[
            { value: ALL, label: 'Tất cả biến thể' },
            ...(variants.data?.items ?? []).map((variant) => ({
              value: variant.id,
              label: `${variant.sku} · ${variant.name}`,
            })),
          ]}
          onChange={(value) => {
            setVariantFilter(value ?? ALL);
            setPage(1);
          }}
        />
        <Select
          label="Trạng thái"
          w={180}
          allowDeselect={false}
          value={statusFilter}
          data={[
            { value: ALL, label: 'Tất cả' },
            { value: 'IN_STOCK', label: ITEM_STATUS_LABELS.IN_STOCK },
            { value: 'RESERVED', label: ITEM_STATUS_LABELS.RESERVED },
            { value: 'SOLD', label: ITEM_STATUS_LABELS.SOLD },
          ]}
          onChange={(value) => {
            setStatusFilter(value ?? ALL);
            setPage(1);
          }}
        />
      </Group>
      {items.isError && <ErrorAlert error={items.error} onReload={() => void items.refetch()} />}
      <Paper withBorder radius="md" bg="white">
        <Table.ScrollContainer minWidth={900}>
          <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Mã tem</Table.Th>
                <Table.Th>Mẫu / biến thể</Table.Th>
                <Table.Th>Kim loại</Table.Th>
                <Table.Th>Trọng lượng</Table.Th>
                <Table.Th>Tiền công</Table.Th>
                <Table.Th>Giá vốn</Table.Th>
                <Table.Th>Trạng thái</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.data?.items.map((item) => (
                <Table.Tr key={item.id}>
                  <Table.Td>{item.tagCode}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{item.productName}</Text>
                    <Text size="xs" c="dimmed">
                      {item.variantName}
                    </Text>
                  </Table.Td>
                  <Table.Td>{item.metalName}</Table.Td>
                  <Table.Td>{formatWeight(item.weight)}</Table.Td>
                  <Table.Td>{formatMoney(item.laborFee)}</Table.Td>
                  <Table.Td>{formatMoney(item.costPrice)}</Table.Td>
                  <Table.Td>
                    <Badge color={STATUS_COLORS[item.status]}>
                      {ITEM_STATUS_LABELS[item.status]}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group justify="flex-end">
                      <PrintLabelButton tagCode={item.tagCode} />
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      {items.data?.items.length === 0 && <Text c="dimmed">Không có chiếc nào.</Text>}
      {totalPages > 1 && <Pagination total={totalPages} value={page} onChange={setPage} />}
    </Stack>
  );
}

/**
 * Ô tra cứu theo mã tem: hiện món hàng kèm giá hiện tại (trọng lượng × giá bán ra + tiền công, làm tròn tới
 * 1.000 đồng). Kim loại chưa có giá → server trả `METAL_PRICE_NOT_SET`, hiện thông báo tiếng Việt.
 */
function TagLookup() {
  const [tagCode, setTagCode] = useState('');
  const lookup = useMutation({ mutationFn: (code: string) => inventoryApi.getItemByTag(code) });

  const submit = () => {
    const code = tagCode.trim();
    if (code !== '') {
      lookup.mutate(code);
    }
  };

  return (
    <Card withBorder radius="md" padding="md">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Group align="flex-end">
          <TextInput
            label="Tra cứu theo mã tem"
            placeholder="Nhập hoặc quét mã tem rồi nhấn Enter"
            w={320}
            value={tagCode}
            onChange={(event) => setTagCode(event.currentTarget.value)}
          />
          <Button type="submit" loading={lookup.isPending}>
            Tra cứu
          </Button>
        </Group>
      </form>
      {lookup.isError && (
        <Stack mt="md">
          <ErrorAlert error={lookup.error} />
        </Stack>
      )}
      {lookup.data !== undefined && <LookupResult item={lookup.data} />}
    </Card>
  );
}

function LookupResult({ item }: { item: ItemWithPrice }) {
  return (
    <Stack mt="md" gap="xs">
      <Group justify="space-between">
        <Text fw={600}>
          {item.tagCode} · {item.productName} ({item.variantName})
        </Text>
        <PrintLabelButton tagCode={item.tagCode} />
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Text size="sm">Kim loại: {item.metalName}</Text>
        <Text size="sm">Trọng lượng: {formatWeight(item.weight)}</Text>
        <Text size="sm">Giá bán ra: {formatMoney(item.sellPricePerChi)} / chỉ</Text>
        <Text size="sm">
          Trạng thái: <b>{ITEM_STATUS_LABELS[item.status]}</b>
        </Text>
      </SimpleGrid>
      <Text fw={700} size="lg">
        Giá hiện tại: {formatMoney(item.price)}
      </Text>
    </Stack>
  );
}
