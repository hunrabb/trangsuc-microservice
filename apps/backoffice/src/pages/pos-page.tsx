import type { ItemWithPrice, PosOrder } from '@jewelry/contracts';
import {
  Alert,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../api/api-error.ts';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { describeError } from '../api/messages.ts';
import { posApi } from '../api/pos-endpoints.ts';
import { useSession } from '../auth/session-context.tsx';
import { formatMoney, formatWeight, ITEM_STATUS_LABELS } from '../inventory/format.ts';
import { BranchSwitcher, useWorkingBranch } from '../inventory/working-branch.tsx';
import { PosCustomerPicker } from '../pos/pos-customer.tsx';
import { PosPayment } from '../pos/pos-payment.tsx';
import {
  addCartItem,
  newPosState,
  readPosState,
  reconcilePosState,
  removeCartItem,
  savePosState,
  selectCustomer,
  type PosState,
} from '../pos/pos-state.ts';

/** Cùng layout chi nhánh của kho; đổi chi nhánh sẽ remount phiên POS riêng của nhân viên. */
export function PosPage() {
  const { me } = useSession();
  const { branchId } = useWorkingBranch();
  if (!me) return <Loader />;
  return (
    <Stack>
      <Title order={2}>Bán tại quầy</Title>
      <BranchSwitcher />
      {branchId === null ? (
        <Alert color="yellow">Chọn chi nhánh trước khi bán.</Alert>
      ) : (
        <PosWorkspace key={`${me.id}:${branchId}`} ownerId={me.id} branchId={branchId} />
      )}
    </Stack>
  );
}

/** Giữ giỏ/key trong localStorage trước HTTP; kết quả chưa rõ được tra theo key, không tự sinh đơn mới. */
function PosWorkspace({ ownerId, branchId }: { ownerId: string; branchId: string }) {
  const [state, setState] = useState(() => readPosState(ownerId, branchId));
  const [order, setOrder] = useState<PosOrder | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [lastLookup, setLastLookup] = useState<ItemWithPrice | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const scanRef = useRef(false);

  const persist = useCallback((next: PosState): boolean => {
    const saved = savePosState(next);
    setStorageFailed(!saved);
    setState(next);
    return saved;
  }, []);

  const recovery = useQuery({
    queryKey: ['pos', 'order-key', state.key],
    queryFn: () => posApi.getOrderByKey(state.key),
    enabled: state.phase !== 'draft',
    retry: false,
  });

  useEffect(() => {
    const found = recovery.data;
    if (!found) return;
    setOrder(found);
    setState((current) => {
      const next = reconcilePosState(current, found);
      if (next !== current) savePosState(next);
      return next;
    });
  }, [recovery.data]);

  const lookup = useMutation({ mutationFn: inventoryApi.getItemByTag });

  /** Chỉ thêm chiếc đang bán được tại chi nhánh hiện tại; cùng mã tem không xuất hiện hai lần. */
  async function scanTag(): Promise<void> {
    const tagCode = tagInput.trim();
    if (scanRef.current || state.phase !== 'draft' || tagCode === '') return;
    if (state.items.some((item) => item.tagCode === tagCode)) {
      setMessage('Mã tem đã có trong giỏ.');
      return;
    }
    scanRef.current = true;
    setLastLookup(null);
    try {
      const item: ItemWithPrice = await lookup.mutateAsync(tagCode);
      setLastLookup(item);
      if (item.branchId !== branchId || item.status !== 'IN_STOCK') {
        setMessage('Món hàng không còn bán được tại chi nhánh này.');
        return;
      }
      persist(addCartItem(state, item));
      setTagInput('');
      setMessage(null);
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      scanRef.current = false;
    }
  }

  /** POST có thể đã chạy dù trình duyệt timeout; mọi lần thử lại dùng cùng body/key đã lưu. */
  async function createOrder(): Promise<void> {
    if (
      busyRef.current ||
      state.items.length === 0 ||
      !['draft', 'uncertain', 'submitting'].includes(state.phase)
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    const submitting: PosState = { ...state, phase: 'submitting' };
    if (!persist(submitting)) {
      setMessage('Không lưu được giỏ và mã chống trùng trên máy này; chưa gửi đơn.');
      busyRef.current = false;
      setBusy(false);
      return;
    }
    try {
      const created = await posApi.createOrder(
        {
          branchId,
          tagCodes: state.items.map((item) => item.tagCode),
          ...(state.customerId ? { customerId: state.customerId } : {}),
        },
        state.key,
      );
      setOrder(created);
      persist({ ...submitting, orderId: created.id, phase: 'ready', pendingAction: null });
    } catch (error) {
      persist({ ...submitting, phase: 'uncertain' });
      setMessage(`${describeError(error)} Kết quả đơn chưa rõ; tra lại hoặc thử lại bằng cùng mã.`);
      void recovery.refetch();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** Thu tiền và huỷ có UPDATE điều kiện ở Sales; khi mất phản hồi chỉ cho thử lại cùng thao tác. */
  async function changePayment(action: 'confirm' | 'cancel'): Promise<void> {
    const canRetryCancellation =
      action === 'cancel' && order?.status === 'CANCELLING' && state.pendingAction === 'cancel';
    if (busyRef.current || (order?.status !== 'PENDING_PAYMENT' && !canRetryCancellation)) return;
    if (state.phase === 'settling' && state.pendingAction !== action) return;
    if (state.phase !== 'ready' && state.phase !== 'settling') return;
    if (
      action === 'cancel' &&
      !canRetryCancellation &&
      !window.confirm('Huỷ hoá đơn và trả hàng về kho?')
    )
      return;
    busyRef.current = true;
    setBusy(true);
    const settling: PosState = { ...state, phase: 'settling', pendingAction: action };
    if (!persist(settling)) {
      setMessage('Không lưu được thao tác thanh toán trên máy này; chưa gửi yêu cầu.');
      busyRef.current = false;
      setBusy(false);
      return;
    }
    try {
      const updated =
        action === 'confirm'
          ? await posApi.confirmPayment(order.id)
          : await posApi.cancelOrder(order.id);
      setOrder(updated);
      persist({ ...settling, phase: 'closed', pendingAction: null });
      setMessage(null);
    } catch (error) {
      setMessage(`${describeError(error)} Hãy tra lại trạng thái trước khi thao tác tiếp.`);
      void recovery.refetch();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const draft = state.phase === 'draft';
  const canRetry = state.phase === 'uncertain' || state.phase === 'submitting';
  return (
    <Stack>
      {storageFailed && (
        <Alert color="red">
          Trình duyệt không lưu được giỏ POS. Không tạo đơn mới cho tới khi có thể lưu mã chống
          trùng.
        </Alert>
      )}
      {message && <Alert color="yellow">{message}</Alert>}
      {recovery.isError && state.phase !== 'draft' && (
        <Alert color="yellow">
          {isApiError(recovery.error) && recovery.error.status === 404
            ? 'Chưa tìm thấy đơn theo key đã lưu; có thể thử gửi lại đúng key.'
            : describeError(recovery.error)}
        </Alert>
      )}
      {recovery.isFetching && <Text size="sm">Đang tra trạng thái hoá đơn…</Text>}
      {draft && (
        <>
          <Paper withBorder p="md" radius="md">
            <Stack>
              <Group align="end">
                <TextInput
                  label="Quét hoặc nhập mã tem"
                  value={tagInput}
                  onChange={(event) => setTagInput(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void scanTag();
                  }}
                />
                <Button loading={lookup.isPending} onClick={() => void scanTag()}>
                  Thêm vào giỏ
                </Button>
              </Group>
              {lastLookup && (
                <Text size="sm">
                  {lastLookup.productName} · {lastLookup.variantName} ·{' '}
                  {formatWeight(lastLookup.weight)} · {formatMoney(lastLookup.price)} ·{' '}
                  {ITEM_STATUS_LABELS[lastLookup.status]}
                  {lastLookup.branchId !== branchId ? ' · Chi nhánh khác' : ''}
                </Text>
              )}
              <Table.ScrollContainer minWidth={650}>
                <Table>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Tem</Table.Th>
                      <Table.Th>Mẫu</Table.Th>
                      <Table.Th>Trọng lượng</Table.Th>
                      <Table.Th>Giá tham khảo</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {state.items.map((item) => (
                      <Table.Tr key={item.tagCode}>
                        <Table.Td>{item.tagCode}</Table.Td>
                        <Table.Td>
                          {item.productName} · {item.variantName}
                        </Table.Td>
                        <Table.Td>{formatWeight(item.weight)}</Table.Td>
                        <Table.Td>{formatMoney(item.price)}</Table.Td>
                        <Table.Td>
                          <Button
                            variant="subtle"
                            color="red"
                            onClick={() => persist(removeCartItem(state, item.tagCode))}
                          >
                            Xoá
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
              {state.items.length === 0 && <Text c="dimmed">Giỏ chưa có món nào.</Text>}
              <Text size="sm" c="dimmed">
                Giá trên giỏ chỉ để tham khảo; hóa đơn dùng giá chốt từ Sales.
              </Text>
            </Stack>
          </Paper>
          <PosCustomerPicker
            branchId={branchId}
            selected={state.customer}
            disabled={!draft}
            onSelect={(customer) => persist(selectCustomer(state, customer))}
          />
          <Button
            w="fit-content"
            loading={busy}
            disabled={state.items.length === 0 || storageFailed}
            onClick={() => void createOrder()}
          >
            Tạo hoá đơn
          </Button>
        </>
      )}
      {canRetry && (
        <Paper withBorder p="md">
          <Stack>
            <Text>Đơn có thể đang xử lý. Mã chống trùng đã được giữ trên máy này.</Text>
            <Button w="fit-content" loading={busy} onClick={() => void createOrder()}>
              Thử lại cùng key
            </Button>
            <Button variant="light" w="fit-content" onClick={() => void recovery.refetch()}>
              Tra trạng thái
            </Button>
          </Stack>
        </Paper>
      )}
      {order && (order.status === 'CREATING' || order.status === 'CANCELLING') && (
        <Alert color="yellow">
          Đơn {order.code} vẫn đang xử lý ({order.status}). Chưa thể xác nhận tiền khi trạng thái
          chưa rõ.
        </Alert>
      )}
      {order?.status === 'CANCELLING' && state.pendingAction === 'cancel' && (
        <Button
          variant="light"
          color="red"
          w="fit-content"
          loading={busy}
          onClick={() => void changePayment('cancel')}
        >
          Thử trả hàng và huỷ tiếp
        </Button>
      )}
      {order &&
        (order.status === 'PENDING_PAYMENT' ||
          order.status === 'COMPLETED' ||
          order.status === 'CANCELLED') && (
          <PosPayment
            order={order}
            busy={busy || recovery.isFetching}
            pendingAction={state.pendingAction}
            onConfirm={() => void changePayment('confirm')}
            onCancel={() => void changePayment('cancel')}
            onNewSale={() => {
              setOrder(null);
              setMessage(null);
              persist(newPosState(ownerId, branchId));
            }}
          />
        )}
      {state.phase === 'settling' && (
        <Button variant="light" w="fit-content" onClick={() => void recovery.refetch()}>
          Tra lại trạng thái thu tiền / huỷ
        </Button>
      )}
    </Stack>
  );
}
