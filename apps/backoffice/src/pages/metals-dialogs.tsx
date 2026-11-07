import type { Metal } from '@jewelry/contracts';
import {
  Button,
  Group,
  Modal,
  Pagination,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { inventoryKeys } from '../api/inventory-queries.ts';
import { boundFieldErrors, ErrorAlert } from '../components/error-alert.tsx';
import {
  formatDateTime,
  formatMoney,
  isDecimalText,
  isZeroText,
  METAL_KIND_LABELS,
} from '../inventory/format.ts';

const HISTORY_PAGE_SIZE = 10;

// ---------------------------------------------------------------- Thêm kim loại
interface CreateMetalValues {
  code: string;
  name: string;
  kind: 'GOLD' | 'SILVER';
}

const CREATE_METAL_FIELDS = ['code', 'name', 'kind'];

/** Thêm một loại kim loại (ví dụ "Vàng 18K", "Bạc 925"). Mã trùng → lỗi hiện cạnh ô mã. */
export function CreateMetalModal({ onClose }: { onClose(): void }) {
  const queryClient = useQueryClient();
  const form = useForm<CreateMetalValues>({
    initialValues: { code: '', name: '', kind: 'GOLD' },
    validate: {
      code: (value) => (value.trim() === '' ? 'Nhập mã kim loại' : null),
      name: (value) => (value.trim() === '' ? 'Nhập tên kim loại' : null),
    },
  });
  const create = useMutation({
    mutationFn: (values: CreateMetalValues) =>
      inventoryApi.createMetal({
        code: values.code.trim(),
        name: values.name.trim(),
        kind: values.kind,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.metals });
      notifications.show({ color: 'green', message: 'Đã thêm kim loại.' });
      onClose();
    },
    onError: (error) => form.setErrors(boundFieldErrors(error, CREATE_METAL_FIELDS)),
  });

  return (
    <Modal opened onClose={onClose} title="Thêm kim loại" centered>
      <form onSubmit={form.onSubmit((values) => create.mutate(values))}>
        <ErrorAlert error={create.error} boundFields={CREATE_METAL_FIELDS} />
        <Stack>
          <TextInput
            label="Mã"
            placeholder="VANG18K"
            withAsterisk
            {...form.getInputProps('code')}
          />
          <TextInput
            label="Tên"
            placeholder="Vàng 18K"
            withAsterisk
            {...form.getInputProps('name')}
          />
          <Select
            label="Loại"
            allowDeselect={false}
            data={[
              { value: 'GOLD', label: METAL_KIND_LABELS.GOLD },
              { value: 'SILVER', label: METAL_KIND_LABELS.SILVER },
            ]}
            {...form.getInputProps('kind')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" loading={create.isPending}>
              Thêm
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Nhập giá mới
interface NewPriceValues {
  buyPrice: string;
  sellPrice: string;
  effectiveFrom: string;
}

const PRICE_FIELDS = ['buyPrice', 'sellPrice', 'effectiveFrom'];

/**
 * Nhập giá mua và giá bán mới (đồng / chỉ). Giá chỉ ghi thêm, không sửa giá cũ. Để trống "Có hiệu lực từ" thì
 * có hiệu lực ngay. Giá bán không được thấp hơn giá mua (server cũng kiểm).
 */
export function NewPriceModal({ metal, onClose }: { metal: Metal; onClose(): void }) {
  const queryClient = useQueryClient();
  const form = useForm<NewPriceValues>({
    initialValues: { buyPrice: '', sellPrice: '', effectiveFrom: '' },
    validate: {
      buyPrice: (value) => validatePrice(value),
      sellPrice: (value, values) =>
        validatePrice(value) ??
        (Number(value) < Number(values.buyPrice) ? 'Giá bán không được thấp hơn giá mua' : null),
    },
  });
  const save = useMutation({
    mutationFn: (values: NewPriceValues) =>
      inventoryApi.createMetalPrice(metal.id, {
        buyPrice: values.buyPrice.trim(),
        sellPrice: values.sellPrice.trim(),
        ...(values.effectiveFrom === ''
          ? {}
          : { effectiveFrom: new Date(values.effectiveFrom).toISOString() }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.metals });
      notifications.show({ color: 'green', message: `Đã nhập giá mới cho ${metal.name}.` });
      onClose();
    },
    onError: (error) => form.setErrors(boundFieldErrors(error, PRICE_FIELDS)),
  });

  return (
    <Modal opened onClose={onClose} title={`Nhập giá mới: ${metal.name}`} centered>
      <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
        <ErrorAlert error={save.error} boundFields={PRICE_FIELDS} />
        <Stack>
          <Text size="sm" c="dimmed">
            Giá tính bằng đồng cho mỗi chỉ. Giá cũ vẫn được giữ trong lịch sử.
          </Text>
          <TextInput
            label="Giá mua vào (đồng / chỉ)"
            inputMode="decimal"
            withAsterisk
            {...form.getInputProps('buyPrice')}
          />
          <TextInput
            label="Giá bán ra (đồng / chỉ)"
            inputMode="decimal"
            withAsterisk
            {...form.getInputProps('sellPrice')}
          />
          <TextInput
            label="Có hiệu lực từ"
            description="Để trống nếu áp dụng ngay."
            type="datetime-local"
            {...form.getInputProps('effectiveFrom')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" loading={save.isPending}>
              Lưu giá
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** Kiểm tra ô giá: số không âm tối đa 2 chữ số thập phân và lớn hơn 0. */
function validatePrice(value: string): string | null {
  if (!isDecimalText(value, 2)) {
    return 'Nhập số tiền hợp lệ (tối đa 2 chữ số thập phân)';
  }
  return isZeroText(value) ? 'Giá phải lớn hơn 0' : null;
}

// ---------------------------------------------------------------- Lịch sử giá
/** Lịch sử giá của một kim loại, mới nhất trước, phân trang. */
export function PriceHistoryModal({ metal, onClose }: { metal: Metal; onClose(): void }) {
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: inventoryKeys.metalPrices(metal.id, page),
    queryFn: () => inventoryApi.listMetalPrices(metal.id, page, HISTORY_PAGE_SIZE),
  });
  const totalPages = Math.max(1, Math.ceil((history.data?.total ?? 0) / HISTORY_PAGE_SIZE));

  return (
    <Modal opened onClose={onClose} title={`Lịch sử giá: ${metal.name}`} centered size="lg">
      {history.isError && (
        <ErrorAlert error={history.error} onReload={() => void history.refetch()} />
      )}
      <Table.ScrollContainer minWidth={420}>
        <Table verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Hiệu lực từ</Table.Th>
              <Table.Th>Giá mua</Table.Th>
              <Table.Th>Giá bán</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {history.data?.items.map((price) => (
              <Table.Tr key={price.id}>
                <Table.Td>{formatDateTime(price.effectiveFrom)}</Table.Td>
                <Table.Td>{formatMoney(price.buyPrice)}</Table.Td>
                <Table.Td>{formatMoney(price.sellPrice)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {history.data?.items.length === 0 && <Text c="dimmed">Chưa có giá nào.</Text>}
      {totalPages > 1 && <Pagination mt="md" total={totalPages} value={page} onChange={setPage} />}
    </Modal>
  );
}
