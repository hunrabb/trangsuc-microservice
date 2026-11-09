import type { DeadLetterMessage } from '@jewelry/contracts';
import {
  Badge,
  Button,
  Group,
  Modal,
  Pagination,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { dlqApi } from '../api/dlq-endpoints.ts';
import { describeError } from '../api/messages.ts';
import { isAdmin } from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { ErrorAlert } from '../components/error-alert.tsx';
import { canReplayDeadLetter, dlqListState } from './dlq-view.ts';

const PAGE_SIZE = 20;
const dateLabel = (value: string) =>
  new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

/** Chỉ quan sát metadata đã lọc; chi tiết và xác nhận replay dùng chính quyền ADMIN từ backend. */
export function DlqPage() {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [service, setService] = useState<string | null>(null);
  const [eventTypeInput, setEventTypeInput] = useState('');
  const [eventType, setEventType] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState<DeadLetterMessage | null>(null);
  const [confirm, setConfirm] = useState(false);
  const admin = me !== undefined && isAdmin(me.branches);
  const queryKey = ['dlq', page, service, eventType, status];
  const messages = useQuery({
    queryKey,
    queryFn: () =>
      dlqApi.list({
        page,
        pageSize: PAGE_SIZE,
        service: service ?? undefined,
        eventType: eventType || undefined,
        status: status ?? undefined,
      }),
    enabled: admin,
  });
  const detail = useQuery({
    queryKey: ['dlq-detail', selected?.id],
    queryFn: () => dlqApi.detail(selected!.id),
    enabled: admin && selected !== null,
  });
  const replay = useMutation({
    mutationFn: (id: string) => dlqApi.replay(id),
    onSuccess: async (result) => {
      setConfirm(false);
      notifications.show({ color: 'blue', message: result.message });
      await queryClient.invalidateQueries({ queryKey: ['dlq'] });
      await queryClient.invalidateQueries({ queryKey: ['dlq-detail'] });
    },
    onError: (error) => {
      setConfirm(false);
      notifications.show({ color: 'red', message: describeError(error) });
      void queryClient.invalidateQueries({ queryKey: ['dlq'] });
      void queryClient.invalidateQueries({ queryKey: ['dlq-detail'] });
    },
  });

  if (!admin) return null;
  const shown = detail.data?.id === selected?.id ? detail.data : selected;
  const pages = Math.max(1, Math.ceil((messages.data?.total ?? 0) / PAGE_SIZE));
  const listState = dlqListState({
    loading: messages.isPending,
    error: messages.isError,
    itemCount: messages.data?.items.length ?? 0,
  });

  return (
    <Stack>
      <Title order={2}>Thư lỗi DLQ</Title>
      <Text size="sm" c="dimmed">
        Danh sách được lưu từ bản sao quan sát. Phát lại chỉ xác nhận broker đã nhận thư; kết quả xử
        lý có thể đến sau.
      </Text>
      <Group align="end">
        <Select
          label="Service"
          w={180}
          clearable
          value={service}
          onChange={(value) => {
            setService(value);
            setPage(1);
          }}
          data={[
            { value: 'inventory', label: 'Kho' },
            { value: 'sales', label: 'Bán hàng' },
            { value: 'report', label: 'Báo cáo' },
          ]}
        />
        <TextInput
          label="Loại sự kiện"
          placeholder="order.paid"
          value={eventTypeInput}
          onChange={(event) => setEventTypeInput(event.currentTarget.value)}
        />
        <Select
          label="Từng có trạng thái"
          w={210}
          clearable
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          data={[
            'REQUESTED',
            'REPUBLISHED',
            'PUBLISH_FAILED',
            'PUBLISH_UNCONFIRMED',
            'PROCESSING_FAILED',
          ]}
        />
        <Button
          variant="light"
          onClick={() => {
            setEventType(eventTypeInput.trim());
            setPage(1);
          }}
        >
          Lọc
        </Button>
        <Button variant="subtle" onClick={() => void messages.refetch()}>
          Tải lại
        </Button>
      </Group>
      {messages.isError && (
        <ErrorAlert error={messages.error} onReload={() => void messages.refetch()} />
      )}
      <Paper withBorder radius="md">
        <Table.ScrollContainer minWidth={850}>
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Thời điểm</Table.Th>
                <Table.Th>Service / queue</Table.Th>
                <Table.Th>Sự kiện</Table.Th>
                <Table.Th>Lỗi</Table.Th>
                <Table.Th>Trạng thái</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {messages.data?.items.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>{dateLabel(row.failedAt)}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{row.sourceService}</Text>
                    <Text size="xs" c="dimmed">
                      {row.sourceQueue}
                    </Text>
                  </Table.Td>
                  <Table.Td>{row.eventType ?? 'Không xác định'}</Table.Td>
                  <Table.Td>{row.failureReason}</Table.Td>
                  <Table.Td>
                    <Badge color={row.replayable ? 'blue' : 'gray'}>
                      {row.attempts[0]?.status ?? 'Chưa phát lại'}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Button size="xs" variant="light" onClick={() => setSelected(row)}>
                      Chi tiết
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {listState === 'LOADING' && <Text p="md">Đang tải thư lỗi…</Text>}
        {listState === 'EMPTY' && <Text p="md">Không có thư lỗi trong bộ lọc này.</Text>}
      </Paper>
      {pages > 1 && <Pagination value={page} total={pages} onChange={setPage} />}
      <Modal
        opened={selected !== null}
        onClose={() => setSelected(null)}
        title="Chi tiết thư lỗi"
        centered
        size="lg"
      >
        {detail.isPending && <Text>Đang tải chi tiết…</Text>}
        {detail.isError && (
          <ErrorAlert error={detail.error} onReload={() => void detail.refetch()} />
        )}
        {shown && (
          <Stack gap="xs">
            <Text>Queue: {shown.deadLetterQueue}</Text>
            <Text>Ghi nhận lúc: {dateLabel(shown.failedAt)}</Text>
            <Text>Routing key gốc: {shown.routingKey ?? 'Không rõ'}</Text>
            <Text>Event ID: {shown.eventId ?? 'Không có'}</Text>
            <Text>Correlation ID: {shown.correlationId ?? 'Không có'}</Text>
            <Text>Số lần retry: {shown.retryCount ?? 'Không rõ'}</Text>
            <Text>Nguyên nhân: {shown.failureReason}</Text>
            <Text>Số lần phát lại: {shown.replayCount}/3</Text>
            {shown.attempts.map((attempt) => (
              <Text size="sm" key={attempt.id}>
                {dateLabel(attempt.requestedAt)} — {attempt.status}
              </Text>
            ))}
            {canReplayDeadLetter(admin, shown) && (
              <Button onClick={() => setConfirm(true)}>Phát lại sự kiện</Button>
            )}
            {!shown.replayable && (
              <Text size="sm" c="dimmed">
                Thư không đủ điều kiện phát lại an toàn.
              </Text>
            )}
          </Stack>
        )}
      </Modal>
      <ConfirmDialog
        opened={confirm}
        title="Xác nhận phát lại"
        confirmLabel="Phát lại"
        loading={replay.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() => shown && replay.mutate(shown.id)}
      >
        Gửi lại sự kiện {shown?.eventType ?? ''} vào đúng luồng gốc? Thư trong DLQ sẽ được giữ
        nguyên.
      </ConfirmDialog>
    </Stack>
  );
}
