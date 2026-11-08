import type { PosCustomer } from '@jewelry/contracts';
import { Alert, Button, Group, Paper, Stack, Table, Text, TextInput } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '../api/api-error.ts';
import { describeError } from '../api/messages.ts';
import { posApi } from '../api/pos-endpoints.ts';
import { formatDateTime, formatMoney } from '../inventory/format.ts';

interface Props {
  branchId: string;
  selected: PosCustomer | null;
  disabled: boolean;
  onSelect(customer: PosCustomer | null): void;
}

/** Chỉ tìm/tạo khách khi nhân viên chủ động nhập; lịch sử luôn lọc ở chi nhánh đang bán. */
export function PosCustomerPicker({ branchId, selected, disabled, onSelect }: Props) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const find = useMutation({
    mutationFn: () => posApi.findCustomer(phone, branchId),
    onSuccess: onSelect,
  });
  const create = useMutation({
    mutationFn: () => posApi.createCustomer({ branchId, phone, name }),
    onSuccess: onSelect,
  });
  const history = useQuery({
    queryKey: ['pos', 'customer', selected?.id, branchId],
    queryFn: () => posApi.customerOrders(selected!.id, branchId),
    enabled: selected !== null,
  });

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Text fw={600}>Khách hàng (không bắt buộc)</Text>
        {selected ? (
          <Group justify="space-between">
            <Text>
              {selected.name} · {selected.phone}
            </Text>
            <Button variant="subtle" disabled={disabled} onClick={() => onSelect(null)}>
              Bỏ khách
            </Button>
          </Group>
        ) : (
          <>
            <Group align="end">
              <TextInput
                label="Số điện thoại"
                value={phone}
                onChange={(event) => setPhone(event.currentTarget.value)}
                disabled={disabled}
              />
              <Button
                variant="light"
                loading={find.isPending}
                disabled={disabled || phone.trim() === ''}
                onClick={() => find.mutate()}
              >
                Tìm khách
              </Button>
            </Group>
            {find.isError && !isApiError(find.error) && (
              <Alert color="red">{describeError(find.error)}</Alert>
            )}
            {find.isError && isApiError(find.error) && find.error.status !== 404 && (
              <Alert color="red">{describeError(find.error)}</Alert>
            )}
            {find.isError && isApiError(find.error) && find.error.status === 404 && (
              <Text size="sm">Chưa có khách này. Nhập tên để tạo mới nếu khách đồng ý.</Text>
            )}
            <Group align="end">
              <TextInput
                label="Tên khách mới"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                disabled={disabled}
              />
              <Button
                variant="light"
                loading={create.isPending}
                disabled={disabled || phone.trim() === '' || name.trim() === ''}
                onClick={() => create.mutate()}
              >
                Tạo khách
              </Button>
            </Group>
            {create.isError && <Alert color="red">{describeError(create.error)}</Alert>}
          </>
        )}
        {selected && history.data && (
          <>
            <Text size="sm" fw={600}>
              Đơn đã thanh toán tại chi nhánh này
            </Text>
            {history.data.items.length === 0 ? (
              <Text size="sm" c="dimmed">
                Chưa có đơn.
              </Text>
            ) : (
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Ngày</Table.Th>
                    <Table.Th>Mã đơn</Table.Th>
                    <Table.Th>Tổng</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {history.data.items.map((order) => (
                    <Table.Tr key={order.id}>
                      <Table.Td>{formatDateTime(order.createdAt)}</Table.Td>
                      <Table.Td>{order.code}</Table.Td>
                      <Table.Td>{formatMoney(order.total)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </>
        )}
        {history.isError && <Alert color="red">{describeError(history.error)}</Alert>}
      </Stack>
    </Paper>
  );
}
