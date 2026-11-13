import { Alert, Badge, Button, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import type { BuybackDetail, BuybackQuote } from '@jewelry/contracts';
import { formatDateTime, formatMoney, formatWeight } from '../inventory/format.ts';
import { QUOTE_STATUS } from './model.ts';

/** Snapshot tiền chỉ đọc từ Sales; thao tác duyệt giữ riêng trong QuotePanel. */
export function QuoteView({
  detail,
  quote,
  canDecide,
  approvalReason,
  onApprove,
  onReject,
}: {
  detail: BuybackDetail;
  quote: BuybackQuote;
  canDecide: boolean;
  approvalReason: string | null;
  onApprove(): void;
  onReject(): void;
}) {
  return (
    <Paper withBorder p="md">
      <Stack>
        <Group justify="space-between">
          <Title order={4}>Báo giá hiện hành</Title>
          <Badge
            color={
              quote.status === 'APPROVED' ? 'green' : quote.status === 'REJECTED' ? 'red' : 'blue'
            }
          >
            {QUOTE_STATUS[quote.status]}
          </Badge>
        </Group>
        <Text>
          Giá trị thu mua được backend tính: <b>{formatMoney(quote.total)}</b>
        </Text>
        <Text size="sm">
          Mã báo giá: {quote.id} · người lập: {quote.quotedBy} · {formatDateTime(quote.quotedAt)} ·
          nguồn phiên bản phiếu {quote.sourceVersion}
        </Text>
        <Text size="sm" c="dimmed">
          Đơn giá VND/chỉ hợp kim; làm tròn nửa lên 1.000 VND cho từng món.
        </Text>
        <Table.ScrollContainer minWidth={760}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Món</Table.Th>
                <Table.Th>Trọng lượng chấp nhận</Table.Th>
                <Table.Th>Kim loại / giá</Table.Th>
                <Table.Th>Khấu trừ</Table.Th>
                <Table.Th>Thành tiền</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {quote.lines.map((line) => (
                <Table.Tr key={line.itemId}>
                  <Table.Td>
                    {detail.items.find((item) => item.id === line.itemId)?.description ??
                      line.itemId}
                  </Table.Td>
                  <Table.Td>{formatWeight(line.acceptedWeight)}</Table.Td>
                  <Table.Td>
                    {line.metalCode}
                    <Text size="xs">
                      Inventory: {formatMoney(line.unitPrice)}/chỉ · mã giá {line.priceId}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Hiệu lực {formatDateTime(line.effectiveFrom)} · chụp lúc{' '}
                      {formatDateTime(line.capturedAt)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Policy v{line.policyVersion} · {line.purityPerMille}‰
                    </Text>
                  </Table.Td>
                  <Table.Td>{formatMoney(line.deductionVndPerItem)}</Table.Td>
                  <Table.Td>{formatMoney(line.amount)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {quote.rejectionReason && <Text c="red">Lý do từ chối: {quote.rejectionReason}</Text>}
        {quote.status === 'QUOTED' && canDecide && (
          <>
            {approvalReason && <Alert color="yellow">Không thể tự duyệt: {approvalReason}</Alert>}
            <Group>
              <Button disabled={approvalReason !== null} onClick={onApprove}>
                Duyệt báo giá
              </Button>
              <Button color="red" variant="light" onClick={onReject}>
                Từ chối
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Paper>
  );
}
