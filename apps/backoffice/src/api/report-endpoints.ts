import type { ApiClient } from './api-client.ts';
import { api } from './instance.ts';
import type { DailyReport, ReportFilter, StockReport, TopProduct } from './report-types.ts';

export function reportSearch(filter: ReportFilter): string {
  const search = new URLSearchParams({ from: filter.from, to: filter.to });
  if (filter.branchId) search.set('branchId', filter.branchId);
  return search.toString();
}

export function createReportApi(client: Pick<ApiClient, 'request'>) {
  const path = (name: string, filter: ReportFilter) =>
    `/api/admin/reports/${name}?${reportSearch(filter)}`;
  return {
    daily: (filter: ReportFilter) => client.request<DailyReport>(path('daily', filter)),
    topProducts: (filter: ReportFilter) =>
      client.request<TopProduct[]>(path('top-products', filter)),
    stock: (filter: ReportFilter) => client.request<StockReport>(path('stock-movements', filter)),
  };
}
export const reportApi = createReportApi(api);
