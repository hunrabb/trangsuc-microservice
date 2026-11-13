import {
  Alert,
  Button,
  Group,
  Modal,
  Paper,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { BuybackDetail, BuybackQuoteInput } from '@jewelry/contracts';
import { describeError } from '../api/messages.ts';
import { useSession } from '../auth/session-context.tsx';
import { ErrorAlert } from '../components/error-alert.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { formatMoney, formatWeight } from '../inventory/format.ts';
import { formatDateTime } from '../inventory/format.ts';
import { buybackApi } from './api.ts';
import { canApprove, QUOTE_STATUS, quoteBody, samePurity } from './model.ts';
import { QuoteView } from './quote-view.tsx';

export function QuotePanel({
  branchId,
  detail,
  canQuote,
  canDecide,
}: {
  branchId: string;
  detail: BuybackDetail;
  canQuote: boolean;
  canDecide: boolean;
}) {
  const { me } = useSession();
  const cache = useQueryClient();
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [reason, setReason] = useState('');
  const pendingKeys = useRef(new Map<string, string>());
  const keyFor = (signature: string) => {
    const existing = pendingKeys.current.get(signature);
    if (existing) return existing;
    const key = crypto.randomUUID();
    pendingKeys.current.set(signature, key);
    return key;
  };
  const quotes = useQuery({
    queryKey: ['buyback-quotes', branchId, detail.id],
    queryFn: () => buybackApi.quotes(branchId, detail.id),
  });
  const appraisals = useQuery({
    queryKey: ['buyback-appraisals', branchId, detail.id],
    queryFn: () => buybackApi.appraisals(branchId, detail.id),
  });
  const policies = useQuery({
    queryKey: ['buyback-policies', branchId],
    queryFn: () => buybackApi.policies(branchId),
    enabled: canQuote,
  });
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['buybacks'] }),
      cache.invalidateQueries({ queryKey: ['buyback-quotes', branchId, detail.id] }),
      cache.invalidateQueries({ queryKey: ['buyback-appraisals', branchId, detail.id] }),
    ]);
  };
  const quoteMutation = useMutation({
    mutationFn: async (body: BuybackQuoteInput) => {
      const signature = `quote:${JSON.stringify(body)}`;
      const result = await buybackApi.quote(branchId, detail.id, body, keyFor(signature));
      pendingKeys.current.delete(signature);
      return result;
    },
    onSuccess: async () => {
      setQuoteOpen(false);
      await refresh();
      notifications.show({ color: 'green', message: 'Đã lập báo giá từ giá mua Inventory.' });
    },
    onError: (error) => notifications.show({ color: 'red', message: describeError(error) }),
  });
  const decisionMutation = useMutation({
    mutationFn: async ({ quoteId, approve }: { quoteId: string; approve: boolean }) => {
      const body = approve
        ? { version: detail.version }
        : { version: detail.version, reason: reason.trim() };
      const signature = `${approve ? 'approve' : 'reject'}:${quoteId}:${JSON.stringify(body)}`;
      const result = await buybackApi.decide(
        branchId,
        detail.id,
        quoteId,
        body,
        approve,
        keyFor(signature),
      );
      pendingKeys.current.delete(signature);
      return result;
    },
    onSuccess: async () => {
      setDecision(null);
      setReason('');
      await refresh();
      notifications.show({ color: 'green', message: 'Đã ghi quyết định báo giá.' });
    },
    onError: (error) => notifications.show({ color: 'red', message: describeError(error) }),
  });
  const latest = quotes.data?.quotes.find((quote) => quote.id === quotes.data?.activeQuoteId);
  const appraisalRows = appraisals.data?.items ?? [];
  const complete =
    appraisalRows.length === detail.items.length &&
    appraisalRows.every((row) => detail.items.some((item) => item.id === row.itemId));
  const choices = (itemId: string) => {
    const appraisal = appraisalRows.find((row) => row.itemId === itemId);
    if (!appraisal) return [];
    return (policies.data ?? []).filter(
      (policy) =>
        policy.isActive &&
        policy.metalId === appraisal.metalId &&
        policy.metalKind === appraisal.metalKind &&
        samePurity(policy.purityPerMille, appraisal.purityPerMille),
    );
  };
  const ready =
    complete &&
    appraisalRows.every((row) =>
      choices(row.itemId).some((policy) => policy.id === selection[row.itemId]),
    );
  const makeQuote = () => {
    if (!ready) return;
    quoteMutation.mutate(
      quoteBody(
        detail.version,
        detail.items.map((item) => item.id),
        selection,
        policies.data ?? [],
      ),
    );
  };
  const approvalReason = latest ? canApprove(me, detail, latest) : null;
  return (
    <Stack>
      <Title order={3}>Báo giá thu mua</Title>
      {(quotes.isPending || appraisals.isPending) && <Skeleton h={100} />}
      {quotes.isError && <ErrorAlert error={quotes.error} onReload={() => void quotes.refetch()} />}
      {appraisals.isError && (
        <ErrorAlert error={appraisals.error} onReload={() => void appraisals.refetch()} />
      )}
      {policies.isError && (
        <ErrorAlert error={policies.error} onReload={() => void policies.refetch()} />
      )}
      {canQuote && policies.data && (
        <Paper withBorder p="md">
          <Stack>
            <Title order={4}>Lập báo giá</Title>
            <Text size="sm" c="dimmed">
              Giá mua vào được Sales lấy từ Inventory khi lập báo giá; tiền chính thức và làm tròn
              do backend tính.
            </Text>
            {!complete && (
              <Alert color="yellow">Cần kiểm định đủ tất cả món trước khi báo giá.</Alert>
            )}
            {complete &&
              detail.items.map((item) => {
                const appraisal = appraisalRows.find((row) => row.itemId === item.id);
                const options = choices(item.id);
                return (
                  <Select
                    key={item.id}
                    label={`Món ${item.position}: ${item.description}`}
                    description={
                      appraisal
                        ? `Chấp nhận ${formatWeight(appraisal.acceptedWeight)} · ${appraisal.purityPerMille}‰`
                        : undefined
                    }
                    placeholder={
                      options.length ? 'Chọn policy' : 'Chưa có policy khớp kim loại/hàm lượng'
                    }
                    data={options.map((policy) => ({
                      value: policy.id,
                      label: `${policy.label} · trừ ${formatMoney(policy.deductionVndPerItem)} / món · v${policy.version}`,
                    }))}
                    value={selection[item.id] ?? null}
                    onChange={(value) =>
                      setSelection((current) => ({ ...current, [item.id]: value ?? '' }))
                    }
                  />
                );
              })}
            <Group justify="end">
              <Button
                disabled={!ready}
                loading={quoteMutation.isPending}
                onClick={() => setQuoteOpen(true)}
              >
                Lập báo giá
              </Button>
            </Group>
            <ErrorAlert error={quoteMutation.error} onReload={() => void refresh()} />
            <ConfirmDialog
              opened={quoteOpen}
              title="Xác nhận lập báo giá"
              confirmLabel="Lập báo giá"
              confirmColor="indigo"
              loading={quoteMutation.isPending}
              onCancel={() => setQuoteOpen(false)}
              onConfirm={makeQuote}
            >
              Backend sẽ chụp giá mua mới nhất và lưu báo giá; báo giá chưa duyệt trước đó có thể bị
              thay thế.
            </ConfirmDialog>
          </Stack>
        </Paper>
      )}
      {!latest && !quotes.isPending && <Text c="dimmed">Chưa có báo giá hiện hành.</Text>}
      {latest && (
        <QuoteView
          detail={detail}
          quote={latest}
          canDecide={canDecide}
          approvalReason={approvalReason}
          onApprove={() => setDecision('approve')}
          onReject={() => setDecision('reject')}
        />
      )}
      {quotes.data && quotes.data.quotes.length > 0 && (
        <Paper withBorder p="md">
          <Stack>
            <Title order={4}>Lịch sử báo giá và quyết định</Title>
            <Table.ScrollContainer minWidth={650}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Báo giá</Table.Th>
                    <Table.Th>Giá trị</Table.Th>
                    <Table.Th>Người lập / lúc</Table.Th>
                    <Table.Th>Quyết định</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {quotes.data.quotes.map((quote) => (
                    <Table.Tr key={quote.id}>
                      <Table.Td>{quote.id}</Table.Td>
                      <Table.Td>{formatMoney(quote.total)}</Table.Td>
                      <Table.Td>
                        {quote.quotedBy}
                        <Text size="xs">{formatDateTime(quote.quotedAt)}</Text>
                      </Table.Td>
                      <Table.Td>
                        {QUOTE_STATUS[quote.status]}
                        {quote.decidedBy && (
                          <Text size="xs">
                            {quote.decidedBy} ·{' '}
                            {quote.decidedAt ? formatDateTime(quote.decidedAt) : '—'}
                          </Text>
                        )}
                        {quote.rejectionReason && (
                          <Text size="xs" c="red">
                            {quote.rejectionReason}
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Stack>
        </Paper>
      )}
      <Modal
        opened={decision !== null}
        onClose={() => setDecision(null)}
        centered
        title={decision === 'approve' ? 'Xác nhận duyệt báo giá' : 'Từ chối báo giá'}
      >
        <Stack>
          <Text size="sm">
            {latest?.total ? `Tổng giá trị: ${formatMoney(latest.total)}.` : ''} Quyết định sẽ khóa
            phiếu theo trạng thái mới.
          </Text>
          {decision === 'reject' && (
            <Textarea
              label="Lý do từ chối (5–500 ký tự)"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          )}
          <ErrorAlert error={decisionMutation.error} onReload={() => void refresh()} />
          <Group justify="end">
            <Button variant="default" onClick={() => setDecision(null)}>
              Đóng
            </Button>
            <Button
              color={decision === 'reject' ? 'red' : 'indigo'}
              loading={decisionMutation.isPending}
              disabled={
                !latest ||
                (decision === 'reject' && reason.trim().length < 5) ||
                (decision === 'approve' && approvalReason !== null)
              }
              onClick={() =>
                latest &&
                decisionMutation.mutate({ quoteId: latest.id, approve: decision === 'approve' })
              }
            >
              {decision === 'approve' ? 'Xác nhận duyệt' : 'Xác nhận từ chối'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
