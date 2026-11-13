import type { Receipt } from '@jewelry/contracts';
import {
  Badge,
  Button,
  Card,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { describeError } from '../api/messages.ts';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { inventoryKeys, useAllVariants } from '../api/inventory-queries.ts';
import { canManageReceipts } from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { boundFieldErrors, ErrorAlert } from '../components/error-alert.tsx';
import {
  formatDateTime,
  formatMoney,
  formatWeight,
  isDecimalText,
  isZeroText,
  RECEIPT_STATUS_LABELS,
} from '../inventory/format.ts';

const LINE_FIELDS = ['variantId', 'tagCode', 'weight', 'laborFee', 'costPrice'];

interface LineValues {
  variantId: string;
  tagCode: string;
  weight: string;
  laborFee: string;
  costPrice: string;
}

const EMPTY_LINE: LineValues = {
  variantId: '',
  tagCode: '',
  weight: '',
  laborFee: '',
  costPrice: '',
};

const validatePositiveWeight = (value: string): string | null => {
  if (!isDecimalText(value, 4)) {
    return 'Nhập trọng lượng hợp lệ (tối đa 4 chữ số thập phân)';
  }
  return isZeroText(value) ? 'Phải lớn hơn 0' : null;
};

const validatePositiveMoney = (value: string): string | null => {
  if (!isDecimalText(value, 2)) {
    return 'Nhập số tiền hợp lệ (tối đa 2 chữ số thập phân)';
  }
  return isZeroText(value) ? 'Phải lớn hơn 0' : null;
};

/**
 * Chi tiết một phiếu nhập. Phiếu nháp: thêm từng chiếc (mỗi chiếc một mã tem), xoá dòng; ADMIN bấm duyệt. Duyệt xong
 * phiếu thành "Đã duyệt" và các chiếc vào kho. Mỗi lần thêm hoặc xoá dòng làm `version` của phiếu tăng, nên
 * người duyệt đã mở phiếu từ trước sẽ nhận "Dữ liệu đã bị người khác sửa" thay vì duyệt nhầm nội dung mới.
 */
export function ReceiptDetailPage() {
  const { receiptId = '' } = useParams();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const variants = useAllVariants();
  const [confirmingApproval, setConfirmingApproval] = useState(false);

  const receipt = useQuery({
    queryKey: [...inventoryKeys.receipts, 'detail', receiptId],
    queryFn: () => inventoryApi.getReceipt(receiptId),
  });

  /** Ghi phiếu mới nhất vào bộ nhớ đệm để màn hình có đúng `version` ngay, không chờ tải lại. */
  const storeReceipt = async (updated: Receipt) => {
    queryClient.setQueryData([...inventoryKeys.receipts, 'detail', receiptId], updated);
    await queryClient.invalidateQueries({ queryKey: [...inventoryKeys.receipts, 'list'] });
  };

  const variantLabel = (variantId: string) => {
    const variant = variants.data?.items.find((item) => item.id === variantId);
    return variant === undefined ? '…' : `${variant.sku} · ${variant.name}`;
  };

  if (receipt.isError) {
    return <ErrorAlert error={receipt.error} onReload={() => void receipt.refetch()} />;
  }
  if (receipt.data === undefined) {
    return null;
  }
  const current = receipt.data;
  const isDraft = current.status === 'DRAFT';
  const canEdit = me !== undefined && canManageReceipts(me.branches);
  const canApprove = me !== undefined && canManageReceipts(me.branches);

  return (
    <Stack>
      <Group justify="space-between">
        <Stack gap={0}>
          <Title order={2}>Phiếu nhập {current.code}</Title>
          <Text size="sm" c="dimmed">
            <Text component={Link} to="/nhap-hang" c="indigo" span>
              ← Danh sách phiếu
            </Text>
          </Text>
        </Stack>
        <Badge size="lg" color={isDraft ? 'yellow' : 'green'}>
          {RECEIPT_STATUS_LABELS[current.status]}
        </Badge>
      </Group>
      {current.approvedAt !== null && (
        <Text size="sm">Đã duyệt lúc {formatDateTime(current.approvedAt)}.</Text>
      )}

      {isDraft && canEdit && (
        <AddLineCard
          receiptId={receiptId}
          variantChoices={(variants.data?.items ?? [])
            .filter((variant) => variant.isActive)
            .map((variant) => ({ value: variant.id, label: `${variant.sku} · ${variant.name}` }))}
          onSaved={storeReceipt}
        />
      )}

      <Paper withBorder radius="md" bg="white">
        <Table.ScrollContainer minWidth={720}>
          <Table verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Mã tem</Table.Th>
                <Table.Th>Biến thể</Table.Th>
                <Table.Th>Trọng lượng</Table.Th>
                <Table.Th>Tiền công</Table.Th>
                <Table.Th>Giá vốn</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {current.lines.map((line) => (
                <Table.Tr key={line.id}>
                  <Table.Td>{line.tagCode}</Table.Td>
                  <Table.Td>{variantLabel(line.variantId)}</Table.Td>
                  <Table.Td>{formatWeight(line.weight)}</Table.Td>
                  <Table.Td>{formatMoney(line.laborFee)}</Table.Td>
                  <Table.Td>{formatMoney(line.costPrice)}</Table.Td>
                  <Table.Td>
                    {isDraft && canEdit && (
                      <RemoveLineButton
                        receiptId={receiptId}
                        lineId={line.id}
                        onSaved={storeReceipt}
                      />
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      {current.lines.length === 0 && <Text c="dimmed">Phiếu chưa có chiếc nào.</Text>}

      {isDraft && canApprove && (
        <ApproveSection
          receipt={current}
          confirming={confirmingApproval}
          setConfirming={setConfirmingApproval}
          onApproved={storeReceipt}
          onReload={() => void receipt.refetch()}
        />
      )}
    </Stack>
  );
}

/** Biểu mẫu thêm một chiếc vào phiếu nháp. Lỗi theo trường (ví dụ tem trùng trong phiếu) hiện cạnh ô tương ứng. */
function AddLineCard({
  receiptId,
  variantChoices,
  onSaved,
}: {
  receiptId: string;
  variantChoices: { value: string; label: string }[];
  onSaved(receipt: Receipt): Promise<void>;
}) {
  const form = useForm<LineValues>({
    initialValues: EMPTY_LINE,
    validate: {
      variantId: (value) => (value === '' ? 'Chọn biến thể' : null),
      tagCode: (value) => (value.trim() === '' ? 'Nhập mã tem' : null),
      weight: validatePositiveWeight,
      laborFee: (value) =>
        value === '' || isDecimalText(value, 2) ? null : 'Nhập số tiền hợp lệ hoặc để trống',
      costPrice: validatePositiveMoney,
    },
  });
  const add = useMutation({
    mutationFn: (values: LineValues) =>
      inventoryApi.addReceiptLine(receiptId, {
        variantId: values.variantId,
        tagCode: values.tagCode.trim(),
        weight: values.weight.trim(),
        costPrice: values.costPrice.trim(),
        ...(values.laborFee.trim() === '' ? {} : { laborFee: values.laborFee.trim() }),
      }),
    onSuccess: async (receipt, values) => {
      await onSaved(receipt);
      // Giữ biến thể đã chọn để nhập liên tiếp nhiều chiếc cùng loại.
      form.setValues({ ...EMPTY_LINE, variantId: values.variantId });
      form.resetDirty();
    },
    onError: (error) => form.setErrors(boundFieldErrors(error, LINE_FIELDS)),
  });

  return (
    <Card withBorder radius="md" padding="md">
      <form onSubmit={form.onSubmit((values) => add.mutate(values))}>
        <Title order={5} mb="sm">
          Thêm một chiếc
        </Title>
        <ErrorAlert error={add.error} boundFields={LINE_FIELDS} />
        <Group align="flex-start" grow wrap="wrap">
          <Select
            label="Biến thể"
            searchable
            withAsterisk
            allowDeselect={false}
            data={variantChoices}
            {...form.getInputProps('variantId')}
          />
          <TextInput label="Mã tem" withAsterisk {...form.getInputProps('tagCode')} />
          <TextInput
            label="Trọng lượng (chỉ)"
            inputMode="decimal"
            withAsterisk
            {...form.getInputProps('weight')}
          />
          <TextInput
            label="Tiền công (đồng)"
            description="Để trống: lấy mặc định của biến thể"
            inputMode="decimal"
            {...form.getInputProps('laborFee')}
          />
          <TextInput
            label="Giá vốn (đồng)"
            inputMode="decimal"
            withAsterisk
            {...form.getInputProps('costPrice')}
          />
        </Group>
        <Group justify="flex-end" mt="md">
          <Button type="submit" loading={add.isPending}>
            Thêm vào phiếu
          </Button>
        </Group>
      </form>
    </Card>
  );
}

function RemoveLineButton({
  receiptId,
  lineId,
  onSaved,
}: {
  receiptId: string;
  lineId: string;
  onSaved(receipt: Receipt): Promise<void>;
}) {
  const remove = useMutation({
    mutationFn: () => inventoryApi.removeReceiptLine(receiptId, lineId),
    onSuccess: onSaved,
    onError: (error) => notifications.show({ color: 'red', message: describeError(error) }),
  });
  return (
    <Group justify="flex-end">
      <Button
        size="compact-sm"
        color="red"
        variant="light"
        loading={remove.isPending}
        onClick={() => remove.mutate()}
      >
        Xoá
      </Button>
    </Group>
  );
}

/**
 * Nút duyệt phiếu (ADMIN). Duyệt tạo các chiếc vào kho trong một lần: tem trùng với hàng đã có thì cả phiếu không
 * được duyệt và danh sách mã tem trùng hiện ngay trên phiếu để sửa.
 */
function ApproveSection({
  receipt,
  confirming,
  setConfirming,
  onApproved,
  onReload,
}: {
  receipt: Receipt;
  confirming: boolean;
  setConfirming(value: boolean): void;
  onApproved(receipt: Receipt): Promise<void>;
  onReload(): void;
}) {
  const queryClient = useQueryClient();
  const approve = useMutation({
    mutationFn: () => inventoryApi.approveReceipt(receipt.id, receipt.version),
    onSuccess: async (approved) => {
      setConfirming(false);
      await onApproved(approved);
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.items });
      notifications.show({ color: 'green', message: 'Đã duyệt phiếu, hàng đã vào kho.' });
    },
    onError: () => setConfirming(false),
  });

  return (
    <Stack>
      <ErrorAlert error={approve.error} onReload={onReload} />
      <Group justify="flex-end">
        <Button disabled={receipt.lines.length === 0} onClick={() => setConfirming(true)}>
          Duyệt phiếu
        </Button>
      </Group>
      <ConfirmDialog
        opened={confirming}
        title="Duyệt phiếu nhập"
        confirmLabel="Duyệt"
        confirmColor="indigo"
        loading={approve.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => approve.mutate()}
      >
        Duyệt phiếu {receipt.code} sẽ đưa {receipt.lines.length} chiếc vào kho. Sau khi duyệt không
        sửa được phiếu.
      </ConfirmDialog>
    </Stack>
  );
}
