/** Responses của API Report hiện có (docs/api/report.openapi.yaml). Tiền luôn là chuỗi. */
export interface ReportFilter {
  from: string;
  to: string;
  branchId?: string;
}
export interface DailyRow {
  date: string;
  branchId: string;
  channel: string;
  orderCount: number;
  revenue: string;
  cogs: string | null;
  grossProfit: string | null;
}
export interface DailyReport {
  timezone: string;
  rows: DailyRow[];
}
export interface TopProduct {
  variantId: string | null;
  productName: string;
  quantity: number;
  revenue: string;
}
export interface StockAmount {
  pieces: number;
  chi: string;
  costValue: string;
}
export interface StockRow {
  variantId: string;
  sku: string;
  metalId: string;
  metalCode: string;
  metalKind: string;
  opening: StockAmount;
  received: StockAmount;
  released: StockAmount;
  sold: StockAmount;
  closing: StockAmount;
}
export interface StockWarehouse {
  branchId: string;
  warehouseId: string | null;
  complete: boolean;
  reason: string | null;
  missingDates: string[];
  rows: StockRow[];
}
export interface StockReport {
  timezone: string;
  from: string;
  to: string;
  coverage: string;
  warehouses: StockWarehouse[];
}
export type ExcelReport = 'daily' | 'top-products' | 'stock-movements';
