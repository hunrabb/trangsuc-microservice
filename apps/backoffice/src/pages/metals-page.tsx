import type { Metal } from '@jewelry/contracts';
import { Badge, Button, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { inventoryKeys, useMetals } from '../api/inventory-queries.ts';
import { ErrorAlert } from '../components/error-alert.tsx';
import { PlusIcon } from '../components/icons.tsx';
import { formatDateTime, formatMoney, METAL_KIND_LABELS } from '../inventory/format.ts';
import { CreateMetalModal, NewPriceModal, PriceHistoryModal } from './metals-dialogs.tsx';

type Dialog = { kind: 'create' } | { kind: 'price' | 'history'; metal: Metal };

/**
 * Giá kim loại (chỉ ADMIN): bảng các loại kim loại kèm giá mua và giá bán hiện tại. Giá hiện tại do server
 * quyết định (dòng có hiệu lực mới nhất); kim loại chưa có giá hiện "Chưa có giá".
 */
export function MetalsPage() {
  const metals = useMetals();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const currentPrices = useQueries({
    queries: (metals.data ?? []).map((metal) => ({
      queryKey: inventoryKeys.metalPrice(metal.id),
      queryFn: () => inventoryApi.currentMetalPriceOrNull(metal.id),
    })),
  });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Giá kim loại</Title>
        <Button leftSection={<PlusIcon size={16} />} onClick={() => setDialog({ kind: 'create' })}>
          Thêm kim loại
        </Button>
      </Group>
      {metals.isError && <ErrorAlert error={metals.error} onReload={() => void metals.refetch()} />}
      <Paper withBorder radius="md" bg="white">
        <Table.ScrollContainer minWidth={760}>
          <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Kim loại</Table.Th>
                <Table.Th>Giá mua (đồng / chỉ)</Table.Th>
                <Table.Th>Giá bán (đồng / chỉ)</Table.Th>
                <Table.Th>Hiệu lực từ</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {metals.data?.map((metal, position) => {
                const price = currentPrices[position]?.data;
                return (
                  <Table.Tr key={metal.id}>
                    <Table.Td>
                      <Text fw={500}>{metal.name}</Text>
                      <Group gap="xs">
                        <Text size="xs" c="dimmed">
                          {metal.code}
                        </Text>
                        <Badge size="xs" variant="light">
                          {METAL_KIND_LABELS[metal.kind]}
                        </Badge>
                      </Group>
                    </Table.Td>
                    {price === undefined || price === null ? (
                      <Table.Td colSpan={3}>
                        <Text c="dimmed" size="sm">
                          {price === null ? 'Chưa có giá' : 'Đang tải…'}
                        </Text>
                      </Table.Td>
                    ) : (
                      <>
                        <Table.Td>{formatMoney(price.buyPrice)}</Table.Td>
                        <Table.Td>{formatMoney(price.sellPrice)}</Table.Td>
                        <Table.Td>{formatDateTime(price.effectiveFrom)}</Table.Td>
                      </>
                    )}
                    <Table.Td>
                      <Group gap="xs" justify="flex-end" wrap="nowrap">
                        <Button
                          size="compact-sm"
                          onClick={() => setDialog({ kind: 'price', metal })}
                        >
                          Nhập giá mới
                        </Button>
                        <Button
                          size="compact-sm"
                          variant="default"
                          onClick={() => setDialog({ kind: 'history', metal })}
                        >
                          Lịch sử
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      {metals.data?.length === 0 && (
        <Text c="dimmed">Chưa có kim loại nào. Hãy thêm kim loại trước.</Text>
      )}

      {dialog?.kind === 'create' && <CreateMetalModal onClose={() => setDialog(null)} />}
      {dialog?.kind === 'price' && (
        <NewPriceModal metal={dialog.metal} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'history' && (
        <PriceHistoryModal metal={dialog.metal} onClose={() => setDialog(null)} />
      )}
    </Stack>
  );
}
