import type { PosOrder } from '@jewelry/contracts';
import {
  Alert,
  Badge,
  Button,
  Group,
  Image,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { formatMoney, formatWeight } from '../inventory/format.ts';
import { bankAccountFromEnvironment, vietQrUrl } from './vietqr.ts';
import { useState } from 'react';

interface Props {
  order: PosOrder;
  busy: boolean;
  pendingAction: 'confirm' | 'cancel' | null;
  onConfirm(): void;
  onCancel(): void;
  onNewSale(): void;
}

/** Hoá đơn chỉ hiện giá chốt từ Sales; QR là hướng dẫn chuyển khoản, không tự xác nhận đã nhận tiền. */
export function PosPayment({ order, busy, pendingAction, onConfirm, onCancel, onNewSale }: Props) {
  const bank = bankAccountFromEnvironment();
  const qr = vietQrUrl(order, bank);
  const [imageFailed, setImageFailed] = useState(false);
  const awaitingPayment = order.status === 'PENDING_PAYMENT';
  return (
    <Stack>
      <Paper withBorder p="md" radius="md">
        <Stack>
          <Group justify="space-between">
            <Title order={3}>Hoá đơn {order.code}</Title>
            <Badge
              color={
                order.status === 'COMPLETED'
                  ? 'green'
                  : order.status === 'CANCELLED'
                    ? 'red'
                    : 'yellow'
              }
            >
              {order.status}
            </Badge>
          </Group>
          <Table.ScrollContainer minWidth={650}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Tem</Table.Th>
                  <Table.Th>Mẫu</Table.Th>
                  <Table.Th>Trọng lượng</Table.Th>
                  <Table.Th>Giá chốt</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {order.items.map((item) => (
                  <Table.Tr key={item.id}>
                    <Table.Td>{item.tagCode}</Table.Td>
                    <Table.Td>{item.productName}</Table.Td>
                    <Table.Td>{formatWeight(item.metalWeight)}</Table.Td>
                    <Table.Td>{formatMoney(item.price)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Text fw={700} size="xl">
            Tổng thanh toán: {formatMoney(order.total)}
          </Text>
        </Stack>
      </Paper>
      {awaitingPayment && bank && qr && !imageFailed && (
        <Paper withBorder p="md" radius="md">
          <Stack align="center">
            <Text fw={600}>Chuyển khoản theo mã hoá đơn</Text>
            <Image
              src={qr}
              alt={`VietQR cho hoá đơn ${order.code}`}
              w={270}
              fit="contain"
              onError={() => setImageFailed(true)}
            />
            <Text>
              Ngân hàng BIN {bank.bin} · Số tài khoản {bank.account}
            </Text>
            <Text>Người nhận: {bank.name}</Text>
            <Text>
              Nội dung: <b>{order.code}</b>
            </Text>
            <Text>
              Số tiền: <b>{formatMoney(order.total)}</b>
            </Text>
          </Stack>
        </Paper>
      )}
      {awaitingPayment && imageFailed && (
        <Alert color="red">
          Không tải được VietQR. Hãy đối chiếu thông tin chuyển khoản thủ công, không quét ảnh lỗi.
        </Alert>
      )}
      {awaitingPayment && imageFailed && bank && (
        <Text>
          Ngân hàng BIN {bank.bin} · Số tài khoản {bank.account} · Người nhận {bank.name} · Nội dung{' '}
          {order.code} · Số tiền {formatMoney(order.total)}
        </Text>
      )}
      {awaitingPayment && (!bank || !qr) && (
        <Alert color="yellow">
          Chưa cấu hình đủ tài khoản nhận tiền hoặc số tiền không hợp lệ cho VietQR. Không hiển thị
          mã chuyển khoản; vui lòng dùng quy trình đối chiếu thủ công của cửa hàng.
        </Alert>
      )}
      {awaitingPayment && bank && !qr && (
        <Text>
          Ngân hàng BIN {bank.bin} · Số tài khoản {bank.account} · Người nhận {bank.name} · Nội dung{' '}
          {order.code} · Số tiền {formatMoney(order.total)}
        </Text>
      )}
      {awaitingPayment && (
        <Group>
          <Button
            color="green"
            loading={busy && pendingAction === 'confirm'}
            disabled={busy || pendingAction === 'cancel'}
            onClick={onConfirm}
          >
            Đã nhận tiền
          </Button>
          <Button
            color="red"
            variant="light"
            loading={busy && pendingAction === 'cancel'}
            disabled={busy || pendingAction === 'confirm'}
            onClick={onCancel}
          >
            Huỷ hoá đơn
          </Button>
        </Group>
      )}
      {(order.status === 'COMPLETED' || order.status === 'CANCELLED') && (
        <Button onClick={onNewSale}>Bán đơn mới</Button>
      )}
    </Stack>
  );
}
