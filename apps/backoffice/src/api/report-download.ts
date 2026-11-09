import type { ApiClient } from './api-client.ts';
import { ApiError } from './api-error.ts';
import { reportSearch } from './report-endpoints.ts';
import type { ExcelReport, ReportFilter } from './report-types.ts';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function excelFilename(disposition: string | null, fallback: string): string {
  const safe = (value: string) => /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,140}\.xlsx$/iu.test(value);
  const extended = disposition?.match(/(?:^|;)\s*filename\*=UTF-8''([^;]+)/i)?.[1];
  if (extended) {
    try {
      const value = decodeURIComponent(extended.trim());
      if (safe(value)) return value;
    } catch {
      /* fallback */
    }
  }
  const ordinary = disposition?.match(/(?:^|;)\s*filename=(?:"([^"]*)"|([^;]*))/i);
  const value = (ordinary?.[1] ?? ordinary?.[2])?.trim();
  return value && safe(value) ? value : fallback;
}

/** Dùng chính client đăng nhập, kể cả refresh đồng thời với các truy vấn JSON. */
export async function fetchReportExcel(
  client: Pick<ApiClient, 'requestResponse'>,
  kind: ExcelReport,
  filter: ReportFilter,
) {
  const response = await client.requestResponse(
    `/api/admin/reports/${kind}.xlsx?${reportSearch(filter)}`,
    { accept: XLSX_MIME },
  );
  const invalidFile = () =>
    new ApiError({
      status: response.status,
      code: 'INVALID_DOWNLOAD',
      message: 'Máy chủ không trả về file Excel hợp lệ. Vui lòng thử lại.',
    });
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== XLSX_MIME)
    throw invalidFile();
  const bytes = await response.arrayBuffer();
  const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (
    signature.length !== 4 ||
    signature[0] !== 0x50 ||
    signature[1] !== 0x4b ||
    signature[2] !== 3 ||
    signature[3] !== 4
  )
    throw invalidFile();
  const dates =
    /^\d{4}-\d{2}-\d{2}$/.test(filter.from) && /^\d{4}-\d{2}-\d{2}$/.test(filter.to)
      ? `-${filter.from}-${filter.to}`
      : '';
  return {
    blob: new Blob([bytes], { type: XLSX_MIME }),
    filename: excelFilename(response.headers.get('content-disposition'), `${kind}${dates}.xlsx`),
  };
}

/** Object URL chỉ giữ đến khi trình duyệt bắt đầu tải, không lưu token vào URL. */
export function saveReportExcel(file: { blob: Blob; filename: string }): void {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
