import type { ScanResult, StockCountSummary } from '@jewelry/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { describeError } from '../api/messages.ts';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { inventoryKeys } from '../api/inventory-queries.ts';
import { hasRoleAtBranch } from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { ErrorAlert } from '../components/error-alert.tsx';
import { formatDateTime } from '../inventory/format.ts';
import { rememberLastStockCount } from './stock-counts-page.tsx';

const RECENT_SCAN_LIMIT = 10;

const SCAN_MESSAGES: Record<ScanResult['result'], { color: string; text: string }> = {
  MATCHED: { color: 'green', text: 'Đã ghi nhận' },
  ALREADY_SCANNED: { color: 'yellow', text: 'Đã quét trước đó' },
  EXTRA: { color: 'orange', text: 'Thừa: không thuộc kho này' },
};

interface RecentScan {
  tagCode: string;
  result: ScanResult['result'];
}

/**
 * Một phiên kiểm kê: ô quét mã tem (nhập tay hoặc máy quét đứng, máy quét gõ mã rồi Enter như bàn phím), tổng kết
 * và nút đóng phiên. STAFF quét được; chỉ MANAGER đóng phiên. Mỗi lần quét xong ô nhập được xoá và đặt lại con
 * trỏ để quét tiếp liên tục.
 */
export function StockCountDetailPage() {
  const { stockCountId = '' } = useParams();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [confirmingClose, setConfirmingClose] = useState(false);

  const summaryKey = inventoryKeys.stockCount(stockCountId);
  const summary = useQuery({
    queryKey: summaryKey,
    queryFn: async () => {
      const loaded = await inventoryApi.getStockCount(stockCountId);
      rememberLastStockCount(loaded.branchId, loaded.id);
      return loaded;
    },
  });

  const close = useMutation({
    mutationFn: () => inventoryApi.closeStockCount(stockCountId),
    onSuccess: (closed) => {
      setConfirmingClose(false);
      queryClient.setQueryData(summaryKey, closed);
      notifications.show({ color: 'green', message: 'Đã đóng phiên kiểm kê.' });
    },
    onError: (error) => {
      setConfirmingClose(false);
      notifications.show({ color: 'red', message: describeError(error) });
      void summary.refetch();
    },
  });

  if (summary.isError) {
    return <ErrorAlert error={summary.error} onReload={() => void summary.refetch()} />;
  }
  if (summary.data === undefined) {
    return null;
  }
  const session = summary.data;
  const isOpen = session.status === 'OPEN';
  const canScan =
    me !== undefined && hasRoleAtBranch(me.branches, session.branchId, ['MANAGER', 'STAFF']);
  const canClose = me !== undefined && hasRoleAtBranch(me.branches, session.branchId, ['MANAGER']);

  return (
    <Stack>
      <Group justify="space-between">
        <Stack gap={0}>
          <Title order={2}>Kiểm kê {session.code}</Title>
          <Text size="sm">
            <Text component={Link} to="/kiem-ke" c="indigo" span>
              ← Kiểm kê
            </Text>
          </Text>
        </Stack>
        <Badge size="lg" color={isOpen ? 'yellow' : 'green'}>
          {isOpen ? 'Đang mở' : 'Đã đóng'}
        </Badge>
      </Group>
      {session.closedAt !== null && (
        <Text size="sm">Đóng lúc {formatDateTime(session.closedAt)}.</Text>
      )}

      <SummaryCards session={session} />

      {isOpen && canScan && (
        <ScanBox
          stockCountId={stockCountId}
          onScanned={() => queryClient.invalidateQueries({ queryKey: summaryKey })}
          onSessionClosed={() => void summary.refetch()}
        />
      )}
      {isOpen && canClose && (
        <Group justify="flex-end">
          <Button color="red" variant="light" onClick={() => setConfirmingClose(true)}>
            Đóng phiên
          </Button>
        </Group>
      )}
      {!isOpen && <ResultLists session={session} />}

      <ConfirmDialog
        opened={confirmingClose}
        title="Đóng phiên kiểm kê"
        confirmLabel="Đóng phiên"
        loading={close.isPending}
        onCancel={() => setConfirmingClose(false)}
        onConfirm={() => close.mutate()}
      >
        Còn {session.notScannedCount} chiếc chưa quét sẽ được ghi là thiếu. Sau khi đóng không quét
        thêm được.
      </ConfirmDialog>
    </Stack>
  );
}

function SummaryCards({ session }: { session: StockCountSummary }) {
  const cards = [
    { label: 'Dự kiến', value: session.expectedCount, color: 'indigo' },
    { label: 'Đã quét', value: session.scannedCount, color: 'green' },
    {
      label: session.status === 'OPEN' ? 'Chưa quét' : 'Thiếu',
      value: session.status === 'OPEN' ? session.notScannedCount : session.missingCount,
      color: 'red',
    },
    { label: 'Thừa', value: session.extraCount, color: 'orange' },
  ];
  return (
    <SimpleGrid cols={{ base: 2, sm: 4 }}>
      {cards.map((card) => (
        <Card key={card.label} withBorder radius="md" padding="md">
          <Text size="sm" c="dimmed">
            {card.label}
          </Text>
          <Text fw={700} fz={28} c={card.color}>
            {card.value}
          </Text>
        </Card>
      ))}
    </SimpleGrid>
  );
}

/** Ô quét mã tem và kết quả vài lần quét gần nhất. Quét sau khi phiên đã đóng → báo và tải lại tổng kết. */
function ScanBox({
  stockCountId,
  onScanned,
  onSessionClosed,
}: {
  stockCountId: string;
  onScanned(): Promise<unknown>;
  onSessionClosed(): void;
}) {
  const [tagCode, setTagCode] = useState('');
  const [recentScans, setRecentScans] = useState<RecentScan[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const scan = useMutation({
    mutationFn: (code: string) => inventoryApi.scanStockCount(stockCountId, code),
    onSuccess: async (scanned) => {
      setRecentScans((previous) =>
        [{ tagCode: scanned.tagCode, result: scanned.result }, ...previous].slice(
          0,
          RECENT_SCAN_LIMIT,
        ),
      );
      await onScanned();
    },
    onError: (error) => {
      notifications.show({ color: 'red', message: describeError(error) });
      onSessionClosed();
    },
    onSettled: () => {
      setTagCode('');
      inputRef.current?.focus();
    },
  });

  const submit = () => {
    const code = tagCode.trim();
    if (code !== '') {
      scan.mutate(code);
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
            ref={inputRef}
            autoFocus
            label="Quét mã tem"
            placeholder="Quét hoặc nhập mã tem rồi nhấn Enter"
            w={340}
            value={tagCode}
            onChange={(event) => setTagCode(event.currentTarget.value)}
          />
          <Button type="submit" loading={scan.isPending}>
            Ghi nhận
          </Button>
        </Group>
      </form>
      <Stack gap="xs" mt="md">
        {recentScans.map((entry, position) => (
          <Alert
            key={`${entry.tagCode}:${position}`}
            color={SCAN_MESSAGES[entry.result].color}
            p="xs"
          >
            <b>{entry.tagCode}</b>: {SCAN_MESSAGES[entry.result].text}
          </Alert>
        ))}
      </Stack>
    </Card>
  );
}

/** Danh sách mã tem thiếu và thừa sau khi đóng phiên, để người quản lý xử lý. */
function ResultLists({ session }: { session: StockCountSummary }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      <TagList title={`Thiếu (${session.missingCount})`} tagCodes={session.missingTagCodes} />
      <TagList title={`Thừa (${session.extraCount})`} tagCodes={session.extraTagCodes} />
      {session.movedCount > 0 && (
        <Text size="sm" c="dimmed">
          Còn {session.movedCount} chiếc đã bán hoặc đang giữ trong lúc kiểm kê, không tính thiếu.
        </Text>
      )}
    </SimpleGrid>
  );
}

function TagList({ title, tagCodes }: { title: string; tagCodes: string[] }) {
  return (
    <Paper withBorder radius="md" p="md" bg="white">
      <Text fw={600} mb="xs">
        {title}
      </Text>
      {tagCodes.length === 0 ? (
        <Text size="sm" c="dimmed">
          Không có.
        </Text>
      ) : (
        <List size="sm">
          {tagCodes.map((tagCode) => (
            <List.Item key={tagCode}>{tagCode}</List.Item>
          ))}
        </List>
      )}
    </Paper>
  );
}
