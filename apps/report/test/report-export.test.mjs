import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const { ReportExportService, excelDecimal } = require('../dist/orders/report-export.service.js');
const { ReportsController } = require('../dist/orders/reports.controller.js');
const { ReportsService } = require('../dist/orders/reports.service.js');
const { StockReportsService } = require('../dist/stock/stock-reports.service.js');

const branchId = '11111111-1111-4111-8111-111111111111';
const otherBranchId = '22222222-2222-4222-8222-222222222222';
const filter = { from: '2026-11-01', to: '2026-11-08', branchId };
const manager = { branches: [{ role: 'MANAGER', branchId }] };
const admin = { branches: [{ role: 'ADMIN', branchId: null }] };

function sources() {
  const calls = [];
  const dailyData = {
    timezone: 'Asia/Ho_Chi_Minh',
    rows: [
      {
        date: '2026-11-01',
        branchId,
        channel: 'POS',
        orderCount: 2,
        revenue: '7000000.00',
        cogs: '6000000.00',
        grossProfit: '1000000.00',
      },
      {
        date: '2026-11-02',
        branchId,
        channel: 'POS',
        orderCount: 1,
        revenue: '3500000.00',
        cogs: null,
        grossProfit: null,
      },
    ],
  };
  const topData = [
    {
      variantId: null,
      productName: '  =HYPERLINK("http://bad")',
      quantity: 1,
      revenue: '3500000.00',
    },
  ];
  const stockData = {
    timezone: 'Asia/Ho_Chi_Minh',
    from: filter.from,
    to: filter.to,
    coverage: 'REQUESTED_BRANCH',
    warehouses: [
      {
        branchId,
        warehouseId: '33333333-3333-4333-8333-333333333333',
        complete: false,
        reason: 'MISSING_SNAPSHOT',
        missingDates: ['2026-11-03'],
        rows: [],
      },
    ],
  };
  const reports = {
    daily: async (received, limit) => {
      calls.push(['daily', received, limit]);
      return dailyData;
    },
    topProducts: async (received) => {
      calls.push(['top', received]);
      return topData;
    },
  };
  const stock = {
    movements: async (received, limit) => {
      calls.push(['stock', received, limit]);
      return stockData;
    },
  };
  return { reports, stock, calls, dailyData, topData, stockData };
}

async function openWorkbook(file) {
  assert.equal(file.buffer.subarray(0, 2).toString(), 'PK');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  return workbook;
}

it('doanh thu Excel là XLSX hợp lệ và dùng đúng dữ liệu API, giữ COGS thiếu là trống', async () => {
  const source = sources();
  const exporter = new ReportExportService(source.reports, source.stock);
  const file = await exporter.daily(filter);
  const workbook = await openWorkbook(file);
  const sheet = workbook.getWorksheet('Doanh thu theo ngày');
  assert.equal(file.filename, 'bao-cao-doanh-thu-2026-11-01_2026-11-08.xlsx');
  assert.equal(sheet.getCell('A6').value, 'Ngày');
  assert.equal(sheet.getCell('A7').value, source.dailyData.rows[0].date);
  assert.equal(sheet.getCell('E7').value, Number(source.dailyData.rows[0].revenue));
  assert.equal(sheet.getCell('F8').value, null);
  assert.equal(sheet.getCell('H8').value, 'Thiếu giá vốn');
  assert.equal(sheet.getCell('B4').value, 'Asia/Ho_Chi_Minh');
  assert.deepEqual(source.calls, [['daily', filter, 1000]]);
});

it('top sản phẩm không thực thi công thức và số vượt độ chính xác Excel giữ dạng text', async () => {
  const source = sources();
  const workbook = await openWorkbook(
    await new ReportExportService(source.reports, source.stock).topProducts(filter),
  );
  const name = workbook.getWorksheet('Top sản phẩm').getCell('B7');
  assert.equal(name.value, `'  =HYPERLINK("http://bad")`);
  assert.equal(name.type, ExcelJS.ValueType.String);
  assert.equal(excelDecimal('999999999999999.99', 2), '999999999999999.99');
  assert.deepEqual(source.calls, [['top', filter]]);
});

it('nhập–xuất–tồn thiếu snapshot ghi rõ incomplete và không xuất số giả', async () => {
  const source = sources();
  const workbook = await openWorkbook(
    await new ReportExportService(source.reports, source.stock).stockMovements(filter),
  );
  assert.equal(workbook.getWorksheet('Trạng thái dữ liệu').getCell('C7').value, 'KHÔNG ĐẦY ĐỦ');
  assert.equal(workbook.getWorksheet('Trạng thái dữ liệu').getCell('E7').value, '2026-11-03');
  assert.equal(workbook.getWorksheet('Nhập xuất tồn').getCell('A7').value, null);
  assert.deepEqual(source.calls, [['stock', filter, 2000]]);
});

it('nhập–xuất–tồn đủ dữ liệu giữ đúng số chỉ và giá vốn từ API', async () => {
  const source = sources();
  const amount = (pieces, chi, costValue) => ({ pieces, chi, costValue });
  source.stock.movements = async () => ({
    ...source.stockData,
    warehouses: [
      {
        ...source.stockData.warehouses[0],
        complete: true,
        reason: null,
        missingDates: [],
        rows: [
          {
            variantId: '44444444-4444-4444-8444-444444444444',
            sku: 'NHAN-18K',
            metalCode: '18K',
            metalKind: 'GOLD',
            opening: amount(2, '2.5000', '1800000.00'),
            received: amount(1, '1.2500', '900000.00'),
            released: amount(0, '0.0000', '0.00'),
            sold: amount(1, '1.2500', '900000.00'),
            closing: amount(2, '2.5000', '1800000.00'),
          },
        ],
      },
    ],
  });
  const workbook = await openWorkbook(
    await new ReportExportService(source.reports, source.stock).stockMovements(filter),
  );
  const sheet = workbook.getWorksheet('Nhập xuất tồn');
  assert.equal(sheet.getCell('D7').value, 'NHAN-18K');
  assert.equal(sheet.getCell('H7').value, 2.5);
  assert.equal(sheet.getCell('L7').value, 900000);
  assert.equal(sheet.getCell('S7').value, 2);
  assert.equal(workbook.getWorksheet('Trạng thái dữ liệu').getCell('C7').value, 'Đầy đủ');
});

it('controller kiểm quyền/đầu vào trước khi xuất và gắn header tải an toàn', async () => {
  const source = sources();
  const exporter = new ReportExportService(source.reports, source.stock);
  const controller = new ReportsController(source.reports, source.stock, exporter);
  const headers = new Map();
  const response = { setHeader: (name, value) => headers.set(name, value) };
  await assert.rejects(() =>
    controller.dailyExcel(manager, filter.from, filter.to, otherBranchId, response),
  );
  await assert.rejects(() =>
    controller.dailyExcel(manager, '2026-02-30', filter.to, branchId, response),
  );
  await assert.rejects(() =>
    controller.dailyExcel(admin, '2026-01-01', filter.to, undefined, response),
  );
  assert.deepEqual(source.calls, []);
  const file = await controller.dailyExcel(admin, filter.from, filter.to, undefined, response);
  assert.ok(file.getStream());
  assert.equal(
    headers.get('Content-Type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.match(headers.get('Content-Disposition'), /^attachment; filename="bao-cao-doanh-thu-/);
  assert.equal(headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(source.calls, [
    ['daily', { from: filter.from, to: filter.to, branchId: undefined }, 1000],
  ]);
  assert.deepEqual(Reflect.getMetadata('jewelry:roles', ReportsController.prototype.dailyExcel), [
    'MANAGER',
  ]);
});

it('nguồn doanh thu và tồn kho chặn số dòng quá lớn trước khi tạo workbook', async () => {
  const reports = new ReportsService({
    orderRevenue: {
      groupBy: async (query) => {
        assert.equal(query.take, 1001);
        return Array.from({ length: 1001 }, () => ({}));
      },
    },
  });
  await assert.rejects(
    () => reports.daily(filter, 1000),
    (error) => error.httpStatus === 413,
  );

  let queriedBatches = false;
  const stock = new StockReportsService({
    inventorySnapshot: { count: async () => 2001 },
    inventorySnapshotBatch: {
      count: async () => 1,
      findMany: async () => {
        queriedBatches = true;
        return [];
      },
    },
  });
  await assert.rejects(
    () => stock.movements(filter, 2000),
    (error) => error.httpStatus === 413,
  );
  assert.equal(queriedBatches, false);
});
