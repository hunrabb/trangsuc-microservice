import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Pagination,
  Paper,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type {
  BuybackDetail,
  BuybackQuote,
  ConfirmSettlementPayment,
  CreateExchange,
  CreateSettlement,
  RecordSettlementPayment,
  SettlementView,
} from '@jewelry/contracts';
import {
  cancelSettlementSchema,
  confirmSettlementPaymentSchema,
  createExchangeSchema,
  createSettlementSchema,
  recordSettlementPaymentSchema,
} from '@jewelry/contracts';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { isApiError } from '../api/api-error.ts';
import { describeError } from '../api/messages.ts';
import { useSession } from '../auth/session-context.tsx';
import { ErrorAlert } from '../components/error-alert.tsx';
import { formatDateTime, formatMoney, formatWeight } from '../inventory/format.ts';
import { buybackApi } from './api.ts';
import {
  canConfirmSettlement,
  DIRECTION,
  exchangeItemAvailable,
  SettlementCommandGate,
  SETTLEMENT_STATUS,
} from './settlement-model.ts';

type Command =
  | { type: 'direct'; body: CreateSettlement }
  | { type: 'exchange'; body: CreateExchange }
  | { type: 'record'; settlementId: string; body: RecordSettlementPayment }
  | { type: 'confirm'; settlementId: string; body: ConfirmSettlementPayment }
  | { type: 'cancel'; settlementId: string; body: { version: number; reason: string } };

const methodOptions = [
  { value: 'CASH', label: 'Tiền mặt' },
  { value: 'BANK_TRANSFER', label: 'Chuyển khoản' },
];

/** Chỉ dùng giá/trạng thái Sales trả về; số chênh lệch không được tính tại trình duyệt. */
export function SettlementSummary({ row }: { row: SettlementView }) {
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Group justify="space-between">
          <Title order={4}>
            {row.kind === 'EXCHANGE' ? 'Đổi trang sức' : 'Thanh toán thu mua'}
          </Title>
          <Badge color={SETTLEMENT_STATUS[row.status].color}>
            {SETTLEMENT_STATUS[row.status].label}
          </Badge>
        </Group>
        <Text>
          Mã giao dịch: {row.id} · phiên bản {row.version}
        </Text>
        <Text>
          Giá thu mua đã duyệt: <b>{formatMoney(row.approvedAmount)}</b>
        </Text>
        {row.kind === 'EXCHANGE' && (
          <>
            <Text>Tem trang sức mới: {row.tagCode ?? '—'}</Text>
            <Text>
              Giá bán đã chốt: <b>{formatMoney(row.saleAmount)}</b>
            </Text>
            <Text>
              Chênh lệch backend: <b>{formatMoney(row.difference)}</b>
            </Text>
            <Text>
              {row.direction ? DIRECTION[row.direction] : 'Đang giữ món và chốt giá'}:{' '}
              <b>{formatMoney(row.amountDue)}</b>
            </Text>
            {row.reservationExpiresAt && (
              <Text>Giữ hàng đến: {formatDateTime(row.reservationExpiresAt)}</Text>
            )}
          </>
        )}
        {row.kind === 'DIRECT' && (
          <Text>
            Cửa hàng chi trả: <b>{formatMoney(row.amountDue)}</b>
          </Text>
        )}
        <Text>Hình thức: {row.method === 'CASH' ? 'Tiền mặt' : 'Chuyển khoản'}</Text>
        {row.paymentReference && <Text>Chứng từ đã ghi: {row.paymentReference}</Text>}
        {row.paymentEvidence && <Text>Bằng chứng ghi nhận: {row.paymentEvidence}</Text>}
        {row.paymentRecordedBy && <Text>Người ghi chứng từ: {row.paymentRecordedBy}</Text>}
        {row.paymentConfirmedBy && (
          <Text>
            Người xác nhận: {row.paymentConfirmedBy} ·{' '}
            {row.paymentConfirmedAt ? formatDateTime(row.paymentConfirmedAt) : '—'}
          </Text>
        )}
        {row.confirmationNote && <Text>Ghi chú xác nhận: {row.confirmationNote}</Text>}
        {row.orderId && <Text>Mã đơn bán: {row.orderId}</Text>}
        {row.failureCode && <Text c="red">Mã lỗi: {row.failureCode}</Text>}
        <Text size="sm" c="dimmed">
          Người lập: {row.createdBy} · {formatDateTime(row.createdAt)} · cập nhật{' '}
          {formatDateTime(row.updatedAt)}
        </Text>
      </Stack>
    </Paper>
  );
}

export function SettlementPanel({ detail }: { detail: BuybackDetail }) {
  const { me } = useSession();
  const cache = useQueryClient();
  const branchId = detail.branchId;
  const intakeId = detail.id;
  const gate = useRef(new SettlementCommandGate());
  const [kind, setKind] = useState<'DIRECT' | 'EXCHANGE'>('DIRECT');
  const [method, setMethod] = useState<'CASH' | 'BANK_TRANSFER'>('CASH');
  const [itemPage, setItemPage] = useState(1);
  const [tagCode, setTagCode] = useState('');
  const [reference, setReference] = useState('');
  const [evidence, setEvidence] = useState('');
  const [verificationReference, setVerificationReference] = useState('');
  const [note, setNote] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [confirming, setConfirming] = useState<Command | null>(null);

  const quotes = useQuery({
    queryKey: ['buyback-quotes', branchId, intakeId],
    queryFn: () => buybackApi.quotes(branchId, intakeId),
  });
  const settlement = useQuery({
    queryKey: ['buyback-settlement', branchId, intakeId],
    queryFn: () => buybackApi.settlement(branchId, intakeId),
  });
  const items = useQuery({
    queryKey: ['exchange-items', branchId, itemPage],
    queryFn: () =>
      inventoryApi.listItems({ branchId, status: 'IN_STOCK', page: itemPage, pageSize: 20 }),
    enabled:
      kind === 'EXCHANGE' &&
      detail.status === 'APPROVED' &&
      (!settlement.data || settlement.data.status === 'CANCELLED'),
  });
  const selected = useQuery({
    queryKey: ['exchange-item', tagCode],
    queryFn: () => inventoryApi.getItemByTag(tagCode),
    enabled:
      kind === 'EXCHANGE' &&
      tagCode !== '' &&
      (!settlement.data || settlement.data.status === 'CANCELLED'),
    retry: false,
  });
  const current = settlement.data;
  const approved = quotes.data?.quotes.find(
    (quote) => quote.id === quotes.data?.activeQuoteId && quote.status === 'APPROVED',
  );
  const canStart =
    detail.status === 'APPROVED' &&
    approved !== undefined &&
    (!current || current.status === 'CANCELLED');
  const selectedAvailable = exchangeItemAvailable(selected.data, branchId);

  const action = useMutation({
    mutationFn: ({ command, key }: { command: Command; key: string }) => {
      if (command.type === 'direct')
        return buybackApi.createSettlement(branchId, intakeId, command.body, key);
      if (command.type === 'exchange')
        return buybackApi.createExchange(branchId, intakeId, command.body, key);
      if (command.type === 'record')
        return buybackApi.recordPayment(
          branchId,
          intakeId,
          command.settlementId,
          command.body,
          key,
        );
      if (command.type === 'confirm')
        return buybackApi.confirmPayment(
          branchId,
          intakeId,
          command.settlementId,
          command.body,
          key,
        );
      return buybackApi.cancelSettlement(
        branchId,
        intakeId,
        command.settlementId,
        command.body,
        key,
      );
    },
    onSuccess: async (result) => {
      cache.setQueryData(['buyback-settlement', branchId, intakeId], result);
      await cache.invalidateQueries({ queryKey: ['buyback-settlement', branchId, intakeId] });
      await cache.invalidateQueries({ queryKey: ['buybacks', 'detail', branchId, intakeId] });
      setConfirming(null);
      notifications.show({
        color: result.status === 'RECONCILIATION_REQUIRED' ? 'orange' : 'green',
        message:
          result.status === 'RECONCILIATION_REQUIRED'
            ? 'Giao dịch cần đối soát; dữ liệu đã ghi được giữ nguyên.'
            : 'Đã cập nhật giao dịch thu mua.',
      });
    },
    onError: (error) => notifications.show({ color: 'red', message: describeError(error) }),
  });
  const reload = () => {
    setConfirming(null);
    void Promise.all([
      cache.invalidateQueries({ queryKey: ['buybacks', 'detail', branchId, intakeId] }),
      cache.invalidateQueries({ queryKey: ['buyback-quotes', branchId, intakeId] }),
      cache.invalidateQueries({ queryKey: ['buyback-settlement', branchId, intakeId] }),
    ]);
  };
  const send = (command: Command) => {
    const signature = JSON.stringify({ intakeId, command });
    void gate.current
      .run(signature, (key) => action.mutateAsync({ command, key }))
      .catch(() => undefined);
  };
  const start = () => {
    const body = { version: detail.version, method };
    if (kind === 'DIRECT') {
      const parsed = createSettlementSchema.safeParse(body);
      if (parsed.success) setConfirming({ type: 'direct', body: parsed.data });
    } else {
      const parsed = createExchangeSchema.safeParse({ ...body, tagCode });
      if (parsed.success && selectedAvailable)
        setConfirming({ type: 'exchange', body: parsed.data });
    }
  };
  const record = () => {
    if (!current) return;
    const parsed = recordSettlementPaymentSchema.safeParse({
      version: current.version,
      reference,
      evidence,
    });
    if (parsed.success)
      setConfirming({ type: 'record', settlementId: current.id, body: parsed.data });
  };
  const confirm = () => {
    if (!current || canConfirmSettlement(me, current)) return;
    const parsed = confirmSettlementPaymentSchema.safeParse({
      version: current.version,
      verificationReference,
      note,
    });
    if (parsed.success)
      setConfirming({ type: 'confirm', settlementId: current.id, body: parsed.data });
  };
  const cancel = () => {
    if (!current) return;
    const parsed = cancelSettlementSchema.safeParse({
      version: current.version,
      reason: cancelReason,
    });
    if (parsed.success)
      setConfirming({ type: 'cancel', settlementId: current.id, body: parsed.data });
  };
  const hasPending = settlement.isPending || quotes.isPending;

  return (
    <Stack id="thanh-toan">
      <Title order={3}>Thanh toán và đổi trang sức</Title>
      {hasPending && <Skeleton h={110} />}
      {settlement.isError && (
        <ErrorAlert error={settlement.error} onReload={() => void settlement.refetch()} />
      )}
      {quotes.isError && <ErrorAlert error={quotes.error} onReload={() => void quotes.refetch()} />}
      {approved && <ApprovedQuote quote={approved} />}
      {current && <SettlementSummary row={current} />}
      {current?.status === 'PAYMENT_RECORDED' && (
        <Alert color="orange">
          Đã ghi chứng từ nhưng chưa xác nhận thanh toán/bàn giao. Chưa được coi là hoàn tất.
        </Alert>
      )}
      {current?.status === 'RECONCILIATION_REQUIRED' && (
        <Alert color="red">
          Giao dịch cần đối soát với Inventory/Sales. Worker backend sẽ thử khôi phục; chưa có API
          retry thủ công. Không tạo giao dịch mới hoặc ghi tiền lại.
        </Alert>
      )}
      {current && ['RESERVING', 'FULFILLING', 'CANCELLING'].includes(current.status) && (
        <Alert color="yellow">
          Đang chờ backend đồng bộ trạng thái. Tải lại giao dịch để xem kết quả mới nhất.
        </Alert>
      )}
      {current &&
        ['RESERVING', 'FULFILLING', 'RECONCILIATION_REQUIRED', 'CANCELLING'].includes(
          current.status,
        ) && (
          <Button variant="light" onClick={() => void settlement.refetch()}>
            Tải lại trạng thái
          </Button>
        )}
      {canStart && (
        <Paper withBorder p="md">
          <Stack>
            <Title order={4}>Lập giao dịch mới</Title>
            <Text size="sm" c="dimmed">
              Chỉ lập từ báo giá đã duyệt. Thanh toán thực tế phải được ghi chứng từ rồi được người
              khác xác nhận.
            </Text>
            <Select
              label="Loại giao dịch"
              value={kind}
              allowDeselect={false}
              data={[
                { value: 'DIRECT', label: 'Thu mua trực tiếp' },
                { value: 'EXCHANGE', label: 'Đổi trang sức' },
              ]}
              onChange={(value) => setKind(value === 'EXCHANGE' ? 'EXCHANGE' : 'DIRECT')}
            />
            <Select
              label="Hình thức thanh toán"
              value={method}
              allowDeselect={false}
              data={methodOptions}
              onChange={(value) => setMethod(value === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH')}
            />
            {kind === 'EXCHANGE' && (
              <Stack>
                <Select
                  searchable
                  label="Trang sức mới trong kho chi nhánh"
                  placeholder="Chọn tem hàng còn trong kho"
                  data={(items.data?.items ?? []).map((item) => ({
                    value: item.tagCode,
                    label: `${item.tagCode} · ${item.productName} · ${formatWeight(item.weight)}`,
                  }))}
                  value={tagCode || null}
                  onChange={(value) => setTagCode(value ?? '')}
                />
                {items.isPending && <Skeleton h={40} />}
                {items.isError && (
                  <ErrorAlert error={items.error} onReload={() => void items.refetch()} />
                )}
                {items.data?.total === 0 && (
                  <Text c="dimmed">Không có món đang bán trong chi nhánh.</Text>
                )}
                {items.data && items.data.total > 20 && (
                  <Pagination
                    value={itemPage}
                    total={Math.ceil(items.data.total / 20)}
                    onChange={setItemPage}
                  />
                )}
                {selected.isPending && tagCode && <Skeleton h={36} />}
                {selected.isError && (
                  <ErrorAlert error={selected.error} onReload={() => void selected.refetch()} />
                )}
                {selected.data && (
                  <Text>
                    Giá Inventory hiện tại: {formatMoney(selected.data.price)} ·{' '}
                    {selected.data.productName} · {formatWeight(selected.data.weight)}. Giá bán và
                    chênh lệch chính thức được Sales chốt khi giữ món.
                  </Text>
                )}
                {selected.data && !selectedAvailable && (
                  <Alert color="red">Món không còn bán được tại chi nhánh này.</Alert>
                )}
              </Stack>
            )}
            <Group justify="end">
              <Button
                loading={action.isPending}
                disabled={kind === 'EXCHANGE' && !selectedAvailable}
                onClick={start}
              >
                {kind === 'EXCHANGE' ? 'Tạo giao dịch đổi hàng' : 'Lập thanh toán thu mua'}
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
      {current?.status === 'AWAITING_PAYMENT' && (
        <Paper withBorder p="md">
          <Stack>
            <Title order={4}>Ghi nhận chứng từ thủ công</Title>
            <Text>
              Khoản {current.direction ? DIRECTION[current.direction].toLowerCase() : 'chưa chốt'}:{' '}
              <b>{formatMoney(current.amountDue)}</b>
            </Text>
            <Alert color="yellow">
              Chỉ ghi chứng từ và bằng chứng; bước này chưa xác nhận ngân hàng hoặc tiền mặt đã
              nhận/chi.
            </Alert>
            <TextInput
              label="Mã chứng từ (5–120 ký tự)"
              value={reference}
              maxLength={120}
              onChange={(event) => setReference(event.currentTarget.value)}
            />
            <Textarea
              label="Bằng chứng giao nhận (10–1000 ký tự)"
              value={evidence}
              maxLength={1000}
              onChange={(event) => setEvidence(event.currentTarget.value)}
            />
            <Group justify="space-between">
              <Button
                variant="light"
                color="red"
                disabled={cancelReason.trim().length < 10}
                loading={action.isPending}
                onClick={cancel}
              >
                Hủy giao dịch
              </Button>
              <Button
                disabled={
                  !recordSettlementPaymentSchema.safeParse({
                    version: current.version,
                    reference,
                    evidence,
                  }).success
                }
                loading={action.isPending}
                onClick={record}
              >
                Ghi chứng từ
              </Button>
            </Group>
            <TextInput
              label="Lý do hủy (ít nhất 10 ký tự)"
              value={cancelReason}
              maxLength={500}
              onChange={(event) => setCancelReason(event.currentTarget.value)}
            />
          </Stack>
        </Paper>
      )}
      {current?.status === 'PAYMENT_RECORDED' && (
        <Paper withBorder p="md">
          <Stack>
            <Title order={4}>Quản lý xác nhận tiền và bàn giao</Title>
            {canConfirmSettlement(me, current) && (
              <Alert color="yellow">{canConfirmSettlement(me, current)}</Alert>
            )}
            <TextInput
              label="Mã đối chiếu xác nhận (5–120 ký tự)"
              value={verificationReference}
              maxLength={120}
              onChange={(event) => setVerificationReference(event.currentTarget.value)}
            />
            <Textarea
              label="Ghi chú xác nhận (10–1000 ký tự)"
              value={note}
              maxLength={1000}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
            <Group justify="end">
              <Button
                disabled={
                  Boolean(canConfirmSettlement(me, current)) ||
                  !confirmSettlementPaymentSchema.safeParse({
                    version: current.version,
                    verificationReference,
                    note,
                  }).success
                }
                loading={action.isPending}
                onClick={confirm}
              >
                Xác nhận thanh toán và bàn giao
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
      {current && <SettlementHistory row={current} />}
      {action.error && <ErrorAlert error={action.error} onReload={reload} />}
      {isApiError(action.error) && action.error.code === 'NETWORK_ERROR' && (
        <Alert color="yellow">
          Không rõ server đã ghi lệnh hay chưa. Tải lại trạng thái trước; nếu vẫn cần gửi lại, giữ
          nguyên nội dung để dùng cùng khóa yêu cầu.
        </Alert>
      )}
      <Modal
        opened={confirming !== null}
        onClose={() => !action.isPending && setConfirming(null)}
        title="Xác nhận thao tác tài chính"
        centered
      >
        <Stack>
          {action.error && <ErrorAlert error={action.error} onReload={reload} />}
          <Text>
            {confirming?.type === 'exchange'
              ? 'Sales sẽ giữ trang sức và chốt giá bán/chênh lệch.'
              : confirming?.type === 'direct'
                ? 'Lập ý định chi trả theo báo giá đã duyệt.'
                : confirming?.type === 'record'
                  ? 'Chỉ ghi chứng từ; chưa xác nhận tiền.'
                  : confirming?.type === 'confirm'
                    ? 'Xác nhận đã đối chiếu tiền và bàn giao. Giao dịch có thể chuyển sang hoàn tất hoặc cần đối soát.'
                    : 'Hủy giao dịch trước khi ghi tiền.'}
          </Text>
          <Group justify="end">
            <Button
              variant="default"
              disabled={action.isPending}
              onClick={() => setConfirming(null)}
            >
              Đóng
            </Button>
            <Button
              color={confirming?.type === 'cancel' ? 'red' : 'indigo'}
              loading={action.isPending}
              onClick={() => confirming && send(confirming)}
            >
              Xác nhận
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

export function ApprovedQuote({ quote }: { quote: BuybackQuote }) {
  return (
    <Text>
      Báo giá đã duyệt <b>{formatMoney(quote.total)}</b> · người duyệt {quote.decidedBy ?? '—'} ·{' '}
      {quote.decidedAt ? formatDateTime(quote.decidedAt) : '—'}
    </Text>
  );
}

/** Backend chỉ trả settlement gần nhất; không dựng lịch sử giao dịch không có trong API. */
export function SettlementHistory({ row }: { row: SettlementView }) {
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Title order={4}>Mốc giao dịch và đối soát</Title>
        <Table.ScrollContainer minWidth={620}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Mốc</Table.Th>
                <Table.Th>Người thực hiện</Table.Th>
                <Table.Th>Thời gian backend cung cấp</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td>Lập {row.kind === 'EXCHANGE' ? 'exchange' : 'settlement'}</Table.Td>
                <Table.Td>{row.createdBy}</Table.Td>
                <Table.Td>{formatDateTime(row.createdAt)}</Table.Td>
              </Table.Tr>
              {row.paymentRecordedBy && (
                <Table.Tr>
                  <Table.Td>Ghi chứng từ {row.paymentReference}</Table.Td>
                  <Table.Td>{row.paymentRecordedBy}</Table.Td>
                  <Table.Td>Không có thời điểm riêng trong API</Table.Td>
                </Table.Tr>
              )}
              {row.paymentConfirmedBy && (
                <Table.Tr>
                  <Table.Td>Xác nhận tiền/bàn giao</Table.Td>
                  <Table.Td>{row.paymentConfirmedBy}</Table.Td>
                  <Table.Td>
                    {row.paymentConfirmedAt ? formatDateTime(row.paymentConfirmedAt) : '—'}
                  </Table.Td>
                </Table.Tr>
              )}
              <Table.Tr>
                <Table.Td>Trạng thái hiện tại: {SETTLEMENT_STATUS[row.status].label}</Table.Td>
                <Table.Td>—</Table.Td>
                <Table.Td>Cập nhật {formatDateTime(row.updatedAt)}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Text size="sm" c="dimmed">
          API chỉ cung cấp giao dịch mới nhất; audit settlement và các giao dịch đã hủy trước đó
          chưa có endpoint đọc riêng.
        </Text>
      </Stack>
    </Paper>
  );
}
