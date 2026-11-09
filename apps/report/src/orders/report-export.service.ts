import { BusinessError } from '@jewelry/common';
import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { ReportsService } from './reports.service';
import { StockReportsService } from '../stock/stock-reports.service';

interface ExportFilter {
  from: string;
  to: string;
  branchId?: string;
}

interface ExportFile {
  filename: string;
  buffer: Buffer;
}

const MAX_EXPORT_DAYS = 31;
const MAX_EXPORT_ROWS = 1_000;
const MAX_SNAPSHOT_ROWS = 2_000;
const EXCEL_TIMEZONE = 'Asia/Ho_Chi_Minh';
const MONEY_FORMAT = '#,##0.00 "đ"';
const WEIGHT_FORMAT = '#,##0.0000 "chỉ"';
const COUNT_FORMAT = '#,##0';

/** Mọi chuỗi chưa tin cậy phải là text, kể cả khi bắt đầu bằng khoảng trắng rồi công thức. */
export function excelText(value: string): string {
  const clean = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join('');
  return /^\s*[=+\-@]/u.test(clean) ? `'${clean}` : clean;
}

/** Số quá lớn để Excel giữ chính xác được lưu dạng text thay vì âm thầm làm tròn. */
export function excelDecimal(value: string | null, places: number): number | string | null {
  if (value === null) return null;
  const numeric = Number(value);
  const scaled = numeric * 10 ** places;
  if (
    !Number.isFinite(numeric) ||
    !Number.isSafeInteger(Math.round(scaled)) ||
    numeric.toFixed(places) !== value
  ) {
    return value;
  }
  return numeric;
}

/** File đi qua gateway có timeout 10 giây và được buffer; chặn kỳ quá dài trước khi query. */
function checkExportRange(filter: ExportFilter): void {
  const days =
    (Date.parse(`${filter.to}T00:00:00Z`) - Date.parse(`${filter.from}T00:00:00Z`)) / 86_400_000 +
    1;
  if (days > MAX_EXPORT_DAYS) {
    throw new BusinessError(
      'VALIDATION_FAILED',
      `Chỉ xuất tối đa ${MAX_EXPORT_DAYS} ngày mỗi lần`,
      400,
    );
  }
}

/** Đầu trang ghi đủ bộ lọc để người nhận file biết phạm vi và múi giờ của số liệu. */
function prepareSheet(
  workbook: ExcelJS.Workbook,
  title: string,
  filter: ExportFilter,
  headers: string[],
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(title);
  sheet.addRow([title]).font = { bold: true, size: 14 };
  sheet.addRow(['Từ ngày', filter.from, 'Đến ngày', filter.to]);
  sheet.addRow(['Chi nhánh', filter.branchId ?? 'Các chi nhánh đã ghi nhận']);
  sheet.addRow(['Múi giờ', EXCEL_TIMEZONE]);
  sheet.getRow(6).values = headers;
  sheet.getRow(6).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 6 }];
  sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: headers.length } };
  for (let index = 1; index <= headers.length; index += 1) {
    sheet.getColumn(index).width = Math.max(16, Math.min(headers[index - 1]!.length + 4, 34));
  }
  return sheet;
}

function formatCells(row: ExcelJS.Row, money: number[], weights: number[], counts: number[]): void {
  for (const column of money) row.getCell(column).numFmt = MONEY_FORMAT;
  for (const column of weights) row.getCell(column).numFmt = WEIGHT_FORMAT;
  for (const column of counts) row.getCell(column).numFmt = COUNT_FORMAT;
}

async function finishWorkbook(
  workbook: ExcelJS.Workbook,
  kind: string,
  filter: ExportFilter,
): Promise<ExportFile> {
  const content = await workbook.xlsx.writeBuffer();
  return {
    filename: `bao-cao-${kind}-${filter.from}_${filter.to}.xlsx`,
    buffer: Buffer.from(content),
  };
}

@Injectable()
export class ReportExportService {
  constructor(
    private readonly reports: ReportsService,
    private readonly stock: StockReportsService,
  ) {}

  /** Xuất đúng các dòng `daily` đang trả cho API JSON, kể cả COGS null của đơn cũ. */
  async daily(filter: ExportFilter): Promise<ExportFile> {
    checkExportRange(filter);
    const data = await this.reports.daily(filter, MAX_EXPORT_ROWS);
    const workbook = new ExcelJS.Workbook();
    const sheet = prepareSheet(workbook, 'Doanh thu theo ngày', filter, [
      'Ngày',
      'Chi nhánh',
      'Kênh',
      'Số đơn',
      'Doanh thu',
      'Giá vốn',
      'Lợi nhuận gộp',
      'Trạng thái giá vốn',
    ]);
    for (const item of data.rows) {
      const row = sheet.addRow([
        item.date,
        excelText(item.branchId),
        excelText(item.channel),
        item.orderCount,
        excelDecimal(item.revenue, 2),
        excelDecimal(item.cogs, 2),
        excelDecimal(item.grossProfit, 2),
        item.cogs === null ? 'Thiếu giá vốn' : 'Đầy đủ',
      ]);
      formatCells(row, [5, 6, 7], [], [4]);
    }
    return finishWorkbook(workbook, 'doanh-thu', filter);
  }

  /** Top sản phẩm dùng trực tiếp 20 dòng đang hiển thị ở API, không tính lại từ đơn. */
  async topProducts(filter: ExportFilter): Promise<ExportFile> {
    checkExportRange(filter);
    const data = await this.reports.topProducts(filter);
    const workbook = new ExcelJS.Workbook();
    const sheet = prepareSheet(workbook, 'Top sản phẩm', filter, [
      'Mã biến thể',
      'Tên mẫu',
      'Số chiếc',
      'Doanh thu',
    ]);
    for (const item of data) {
      const row = sheet.addRow([
        item.variantId ?? '',
        excelText(item.productName),
        item.quantity,
        excelDecimal(item.revenue, 2),
      ]);
      formatCells(row, [4], [], [3]);
    }
    return finishWorkbook(workbook, 'top-san-pham', filter);
  }

  /** Chỉ ghi dòng kho đã đủ dữ liệu; sheet trạng thái giữ rõ kho/ngày thiếu. */
  async stockMovements(filter: ExportFilter): Promise<ExportFile> {
    checkExportRange(filter);
    const data = await this.stock.movements(filter, MAX_SNAPSHOT_ROWS);
    const rowCount = data.warehouses.reduce((count, warehouse) => count + warehouse.rows.length, 0);
    if (data.warehouses.length > MAX_EXPORT_ROWS || rowCount > MAX_EXPORT_ROWS) {
      throw new BusinessError('PAYLOAD_TOO_LARGE', 'Báo cáo quá lớn, hãy thu hẹp bộ lọc', 413);
    }
    const workbook = new ExcelJS.Workbook();
    this.writeStockStatus(workbook, filter, data);
    this.writeStockRows(workbook, filter, data);
    return finishWorkbook(workbook, 'nhap-xuat-ton', filter);
  }

  /** Trạng thái không đầy đủ đi cùng file, không biến kho thiếu snapshot thành số không. */
  private writeStockStatus(
    workbook: ExcelJS.Workbook,
    filter: ExportFilter,
    data: Awaited<ReturnType<StockReportsService['movements']>>,
  ): void {
    const sheet = prepareSheet(workbook, 'Trạng thái dữ liệu', filter, [
      'Chi nhánh',
      'Kho',
      'Trạng thái',
      'Lý do',
      'Ngày thiếu',
      'Phạm vi',
    ]);
    for (const warehouse of data.warehouses) {
      sheet.addRow([
        excelText(warehouse.branchId),
        warehouse.warehouseId ?? '',
        warehouse.complete ? 'Đầy đủ' : 'KHÔNG ĐẦY ĐỦ',
        warehouse.reason ?? '',
        warehouse.missingDates.join(', '),
        data.coverage,
      ]);
    }
    if (data.warehouses.length === 0) {
      sheet.addRow(['', '', 'KHÔNG XÁC ĐỊNH', 'Không có kho đã ghi nhận', '', data.coverage]);
    }
  }

  /** Số chiếc, chỉ, giá vốn từng loại biến động lấy nguyên từ StockReportsService. */
  private writeStockRows(
    workbook: ExcelJS.Workbook,
    filter: ExportFilter,
    data: Awaited<ReturnType<StockReportsService['movements']>>,
  ): void {
    const headers = [
      'Chi nhánh',
      'Kho',
      'Mã biến thể',
      'SKU',
      'Tuổi kim loại',
      'Loại kim loại',
      'Tồn đầu chiếc',
      'Tồn đầu chỉ',
      'Tồn đầu vốn',
      'Nhập chiếc',
      'Nhập chỉ',
      'Nhập vốn',
      'Trả kho chiếc',
      'Trả kho chỉ',
      'Trả kho vốn',
      'Bán chiếc',
      'Bán chỉ',
      'Bán vốn',
      'Tồn cuối chiếc',
      'Tồn cuối chỉ',
      'Tồn cuối vốn',
    ];
    const sheet = prepareSheet(workbook, 'Nhập xuất tồn', filter, headers);
    for (const warehouse of data.warehouses) {
      for (const item of warehouse.rows) {
        const row = sheet.addRow([
          excelText(warehouse.branchId),
          warehouse.warehouseId ?? '',
          excelText(item.variantId),
          excelText(item.sku),
          excelText(item.metalCode),
          excelText(item.metalKind),
          ...this.stockAmounts(item),
        ]);
        formatCells(row, [9, 12, 15, 18, 21], [8, 11, 14, 17, 20], [7, 10, 13, 16, 19]);
      }
    }
  }

  private stockAmounts(item: {
    opening: { pieces: number; chi: string; costValue: string };
    received: { pieces: number; chi: string; costValue: string };
    released: { pieces: number; chi: string; costValue: string };
    sold: { pieces: number; chi: string; costValue: string };
    closing: { pieces: number; chi: string; costValue: string };
  }): Array<number | string> {
    return [item.opening, item.received, item.released, item.sold, item.closing].flatMap(
      (amount) => [amount.pieces, excelDecimal(amount.chi, 4)!, excelDecimal(amount.costValue, 2)!],
    );
  }
}
