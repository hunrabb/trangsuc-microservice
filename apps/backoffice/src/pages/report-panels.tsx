import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import type { BranchRole } from '@jewelry/contracts';
import type { ReactNode } from 'react';
import type {
  DailyReport,
  ExcelReport,
  StockAmount,
  StockReport,
  TopProduct,
} from '../api/report-types.ts';
import { canViewReports } from '../auth/permissions.ts';
import { ErrorAlert } from '../components/error-alert.tsx';
import { formatMoney, formatWeight } from '../inventory/format.ts';
import { reportDate, reportTotals, stockReason } from './report-view.ts';

export interface ReportState<T> {
  data?: T;
  loading: boolean;
  error?: unknown;
  retry(): void;
}
interface Props {
  roles: readonly BranchRole[];
  daily: ReportState<DailyReport>;
  top: ReportState<TopProduct[]>;
  stock: ReportState<StockReport>;
  branchLabel(id: string | null): string;
  canExport: boolean;
  downloading: ExcelReport | null;
  onDownload(kind: ExcelReport): void;
}

function Section({
  title,
  kind,
  state,
  empty,
  children,
  ...props
}: Omit<Props, 'roles' | 'daily' | 'top' | 'stock' | 'branchLabel'> & {
  title: string;
  kind: ExcelReport;
  state: ReportState<unknown>;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="md">
        <Title order={3}>{title}</Title>
        <Button
          variant="light"
          size="xs"
          loading={props.downloading === kind}
          disabled={!props.canExport || props.downloading !== null}
          onClick={() => props.onDownload(kind)}
        >
          Tải Excel · {title}
        </Button>
      </Group>
      {state.loading ? (
        <Group role="status">
          <Loader size="sm" />
          <Text>Đang tải {title.toLowerCase()}…</Text>
        </Group>
      ) : state.error ? (
        <>
          <ErrorAlert error={state.error} />
          <Button size="xs" variant="light" onClick={state.retry}>
            Thử tải lại {title.toLowerCase()}
          </Button>
        </>
      ) : empty ? (
        <Text c="dimmed">Chưa có dữ liệu {title.toLowerCase()} trong khoảng đã chọn.</Text>
      ) : (
        children
      )}
    </Paper>
  );
}

const Amount = ({ value }: { value: StockAmount }) => (
  <Stack gap={2}>
    <Text size="sm" fw={500}>
      {value.pieces.toLocaleString('vi-VN')} chiếc
    </Text>
    <Text size="xs">{formatWeight(value.chi)}</Text>
    <Text size="xs" c="dimmed">
      Vốn: {formatMoney(value.costValue)}
    </Text>
  </Stack>
);

/** View dùng trực tiếp dữ liệu API; thiếu mốc thì chỉ hiển thị cảnh báo, không dựng số tồn giả. */
export function ReportPanels(props: Props) {
  if (!canViewReports(props.roles))
    return <Alert color="red">Bạn không có quyền xem báo cáo.</Alert>;
  const daily = props.daily.data;
  const totals =
    daily && daily.rows.length > 0 && !props.daily.loading && !props.daily.error
      ? reportTotals(daily.rows)
      : undefined;
  const common = {
    canExport: props.canExport,
    downloading: props.downloading,
    onDownload: props.onDownload,
  };
  return (
    <Stack>
      {totals && (
        <>
          <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }}>
            {[
              ['Tổng doanh thu', formatMoney(totals.revenue)],
              ['Số hoá đơn', totals.orderCount.toLocaleString('vi-VN')],
              ['Giá vốn', formatMoney(totals.cogs)],
              ['Lợi nhuận gộp', formatMoney(totals.grossProfit)],
            ].map(([label, value]) => (
              <Paper key={label} withBorder p="md">
                <Text size="sm" c="dimmed">
                  {label}
                </Text>
                <Text size="xl" fw={600}>
                  {value}
                </Text>
              </Paper>
            ))}
          </SimpleGrid>
          {totals.cogs === null && (
            <Alert color="yellow" title="Chưa đầy đủ giá vốn">
              Có đơn lịch sử thiếu giá vốn. Chưa xác định giá vốn và lợi nhuận gộp cho toàn khoảng
              này.
            </Alert>
          )}
        </>
      )}
      <Section
        {...common}
        title="Doanh thu theo ngày"
        kind="daily"
        state={props.daily}
        empty={!daily?.rows.length}
      >
        <Table.ScrollContainer minWidth={850}>
          <Table striped highlightOnHover captionSide="top">
            <Table.Caption>Ngày theo giờ Việt Nam · Doanh thu ghi khi POS nhận tiền</Table.Caption>
            <Table.Thead>
              <Table.Tr>
                {[
                  'Ngày',
                  'Chi nhánh',
                  'Kênh',
                  'Hoá đơn',
                  'Doanh thu',
                  'Giá vốn',
                  'Lợi nhuận gộp',
                ].map((title) => (
                  <Table.Th key={title}>{title}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {daily?.rows.map((row) => (
                <Table.Tr key={`${row.date}:${row.branchId}:${row.channel}`}>
                  <Table.Td>{reportDate(row.date)}</Table.Td>
                  <Table.Td>{props.branchLabel(row.branchId)}</Table.Td>
                  <Table.Td>{row.channel === 'POS' ? 'Tại quầy' : row.channel}</Table.Td>
                  <Table.Td>{row.orderCount.toLocaleString('vi-VN')}</Table.Td>
                  <Table.Td>{formatMoney(row.revenue)}</Table.Td>
                  <Table.Td>
                    {row.cogs === null ? 'Chưa có giá vốn' : formatMoney(row.cogs)}
                  </Table.Td>
                  <Table.Td>{formatMoney(row.grossProfit)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Section>
      <Section
        {...common}
        title="Top sản phẩm"
        kind="top-products"
        state={props.top}
        empty={!props.top.data?.length}
      >
        <Table.ScrollContainer minWidth={500}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Sản phẩm</Table.Th>
                <Table.Th>Số chiếc</Table.Th>
                <Table.Th>Doanh thu</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.top.data?.map((row, index) => (
                <Table.Tr key={`${row.variantId}:${row.productName}:${index}`}>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>{row.productName}</Table.Td>
                  <Table.Td>{row.quantity.toLocaleString('vi-VN')}</Table.Td>
                  <Table.Td>{formatMoney(row.revenue)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Section>
      <Section
        {...common}
        title="Nhập–xuất–tồn"
        kind="stock-movements"
        state={props.stock}
        empty={!props.stock.data?.warehouses.length}
      >
        {props.stock.data?.coverage === 'OBSERVED_WAREHOUSES_ONLY' && (
          <Alert color="blue" mb="md">
            Chỉ hiển thị các kho đã có bản chốt. Chưa xác nhận đủ dữ liệu mọi chi nhánh.
          </Alert>
        )}
        <Stack>
          {props.stock.data?.warehouses.map((warehouse, index) => (
            <div key={warehouse.warehouseId ?? warehouse.branchId}>
              <Group mb="sm">
                <Text fw={600}>
                  {props.branchLabel(warehouse.branchId)} · Kho {index + 1}
                </Text>
                <Badge color={warehouse.complete ? 'green' : 'yellow'}>
                  {warehouse.complete ? 'Đầy đủ' : 'Chưa đầy đủ'}
                </Badge>
              </Group>
              {!warehouse.complete ? (
                <Alert color="yellow" title="Dữ liệu tồn kho chưa đầy đủ">
                  {stockReason(warehouse.reason)}. Chưa thể hiển thị số liệu nhập–xuất–tồn.
                  {warehouse.missingDates.length > 0 && (
                    <Text size="sm" mt="xs">
                      Ngày thiếu: {warehouse.missingDates.map(reportDate).join(', ')}
                    </Text>
                  )}
                </Alert>
              ) : warehouse.rows.length === 0 ? (
                <Text c="dimmed">Không có hàng và biến động trong kỳ.</Text>
              ) : (
                <Table.ScrollContainer minWidth={1000}>
                  <Table striped>
                    <Table.Thead>
                      <Table.Tr>
                        {[
                          'SKU / Tuổi kim loại',
                          'Tồn đầu',
                          'Nhập hàng',
                          'Trả kho',
                          'Xuất bán',
                          'Tồn cuối',
                        ].map((title) => (
                          <Table.Th key={title}>{title}</Table.Th>
                        ))}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {warehouse.rows.map((row) => (
                        <Table.Tr key={row.variantId}>
                          <Table.Td>
                            <Text size="sm">{row.sku}</Text>
                            <Text size="xs" c="dimmed">
                              {row.metalKind === 'GOLD' ? 'Vàng' : 'Bạc'} · {row.metalCode}
                            </Text>
                          </Table.Td>
                          {[row.opening, row.received, row.released, row.sold, row.closing].map(
                            (amount, i) => (
                              <Table.Td key={i}>
                                <Amount value={amount} />
                              </Table.Td>
                            ),
                          )}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
            </div>
          ))}
        </Stack>
      </Section>
    </Stack>
  );
}
