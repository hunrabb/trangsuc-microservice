import { type AuthUser, CurrentUser, Roles } from '@jewelry/common';
import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import { ReportsService, reportFilter } from './reports.service';
import { StockReportsService } from '../stock/stock-reports.service';
import { ReportExportService } from './report-export.service';

type DownloadResponse = { setHeader(name: string, value: string): unknown };

/** Gateway ánh xạ /api/admin/reports/* vào đây; MANAGER chỉ xem chi nhánh của mình. */
@Controller('admin')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly stock: StockReportsService,
    private readonly exports: ReportExportService,
  ) {}

  /** Trả Excel với header tải về; tên file chỉ chứa loại báo cáo và ngày đã validate. */
  private download(response: DownloadResponse, file: { filename: string; buffer: Buffer }) {
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.buffer);
  }

  @Get('daily.xlsx')
  @Roles('MANAGER')
  async dailyExcel(
    @CurrentUser() user: AuthUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('branchId') branchId: string | undefined,
    @Res({ passthrough: true }) response: DownloadResponse,
  ) {
    const file = await this.exports.daily(reportFilter(user, from, to, branchId));
    return this.download(response, file);
  }

  @Get('top-products.xlsx')
  @Roles('MANAGER')
  async topProductsExcel(
    @CurrentUser() user: AuthUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('branchId') branchId: string | undefined,
    @Res({ passthrough: true }) response: DownloadResponse,
  ) {
    const file = await this.exports.topProducts(reportFilter(user, from, to, branchId));
    return this.download(response, file);
  }

  @Get('stock-movements.xlsx')
  @Roles('MANAGER')
  async stockMovementsExcel(
    @CurrentUser() user: AuthUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('branchId') branchId: string | undefined,
    @Res({ passthrough: true }) response: DownloadResponse,
  ) {
    const file = await this.exports.stockMovements(reportFilter(user, from, to, branchId));
    return this.download(response, file);
  }

  @Get('inventory-snapshots')
  @Roles('MANAGER')
  snapshots(
    @CurrentUser() user: AuthUser,
    @Query('date') date: string,
    @Query('branchId') branchId?: string,
  ) {
    const filter = reportFilter(user, date, date, branchId);
    return this.stock.snapshots(filter.from, filter.branchId);
  }

  @Get('stock-movements')
  @Roles('MANAGER')
  stockMovements(
    @CurrentUser() user: AuthUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.stock.movements(reportFilter(user, from, to, branchId));
  }

  @Get('daily')
  @Roles('MANAGER')
  daily(
    @CurrentUser() user: AuthUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reports.daily(reportFilter(user, from, to, branchId));
  }

  @Get('top-products')
  @Roles('MANAGER')
  topProducts(
    @CurrentUser() user: AuthUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reports.topProducts(reportFilter(user, from, to, branchId));
  }
}
