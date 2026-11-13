import type { StockSummaryPage } from '@jewelry/contracts';
import { Button, Paper, Table, Text } from '@mantine/core';

export function StockSummaryTable({
  rows,
  onSelectVariant,
}: {
  rows: StockSummaryPage['items'];
  onSelectVariant: (id: string) => void;
}) {
  return (
    <Paper withBorder radius="md">
      <Table.ScrollContainer minWidth={950}>
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              {[
                'Mẫu / biến thể',
                'SKU',
                'Kim loại',
                'Chi nhánh',
                'Tổng',
                'Khả dụng',
                'Đang giữ',
                'Đã bán',
                'Chờ nấu',
                'Khác',
                '',
              ].map((label) => (
                <Table.Th key={label}>{label}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={`${row.branchId}:${row.variantId}`}>
                <Table.Td>
                  <Text size="sm">{row.productName}</Text>
                  <Text size="xs" c="dimmed">
                    {row.variantName}
                  </Text>
                </Table.Td>
                <Table.Td>{row.sku}</Table.Td>
                <Table.Td>{row.metalName}</Table.Td>
                <Table.Td>{row.branchName}</Table.Td>
                <Table.Td>{row.total}</Table.Td>
                <Table.Td>{row.available}</Table.Td>
                <Table.Td>{row.reserved}</Table.Td>
                <Table.Td>{row.sold}</Table.Td>
                <Table.Td>{row.pendingMelt}</Table.Td>
                <Table.Td>{row.other}</Table.Td>
                <Table.Td>
                  <Button
                    size="compact-sm"
                    variant="light"
                    onClick={() => onSelectVariant(row.variantId)}
                  >
                    Xem mã tem
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}
