import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createApiClient } from './api-client.ts';
import { ApiError } from './api-error.ts';
import { createReportApi } from './report-endpoints.ts';
import { excelFilename, fetchReportExcel, saveReportExcel, XLSX_MIME } from './report-download.ts';

const filter = {
  from: '2026-11-01',
  to: '2026-11-09',
  branchId: '11111111-1111-4111-8111-111111111111',
};
const zip = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = (accessToken: string) => ({
  accessToken,
  expiresIn: 900,
  user: { id: filter.branchId, fullName: 'Test', email: 'test@example.com', branches: [] },
});
function client(fetcher: typeof fetch) {
  const signals = { lost: 0, forbidden: 0 };
  const api = createApiClient({
    fetch: fetcher,
    onSessionLost: () => signals.lost++,
    onForbidden: () => signals.forbidden++,
    schedule: () => () => undefined,
  });
  api.setSession(session('old'));
  return { api, signals };
}

it('Excel và JSON dùng chung một refresh, giữ filter/Accept và không làm mất phiên', async () => {
  let refreshes = 0;
  const calls: { path: string; accept: string | null }[] = [];
  const { api, signals } = client(async (input, init) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ path, accept: headers.get('accept') });
    if (path === '/api/auth/refresh') {
      refreshes++;
      return json(200, session('new'));
    }
    if (headers.get('authorization') === 'Bearer old') return json(401, { code: 'TOKEN_EXPIRED' });
    assert.equal(headers.get('authorization'), 'Bearer new');
    return path.includes('.xlsx')
      ? new Response(zip, {
          headers: {
            'content-type': XLSX_MIME,
            'content-disposition': 'attachment; filename="doanh-thu.xlsx"',
          },
        })
      : json(200, { rows: [] });
  });
  const [file, report] = await Promise.all([
    fetchReportExcel(api, 'daily', filter),
    createReportApi(api).daily(filter),
  ]);
  assert.equal(refreshes, 1);
  assert.equal(signals.lost, 0);
  assert.equal(api.hasSession(), true);
  assert.equal(file.filename, 'doanh-thu.xlsx');
  assert.equal(file.blob.type, XLSX_MIME);
  assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()), zip);
  assert.deepEqual(report.rows, []);
  for (const call of calls.filter((item) => item.path !== '/api/auth/refresh')) {
    const url = new URL(call.path, 'http://localhost');
    assert.equal(url.searchParams.get('from'), filter.from);
    assert.equal(url.searchParams.get('to'), filter.to);
    assert.equal(url.searchParams.get('branchId'), filter.branchId);
    assert.equal(call.accept, call.path.includes('.xlsx') ? XLSX_MIME : 'application/json');
  }
});

it('cả ba endpoint Excel và JSON dùng nguyên bộ lọc, ADMIN bỏ branchId', async () => {
  const paths: string[] = [];
  const { api } = client(async (input) => {
    paths.push(String(input));
    return new Response(zip, { headers: { 'content-type': XLSX_MIME } });
  });
  for (const kind of ['daily', 'top-products', 'stock-movements'] as const) {
    const file = await fetchReportExcel(api, kind, filter);
    assert.equal(file.filename, `${kind}-${filter.from}-${filter.to}.xlsx`);
  }
  const report = createReportApi({
    request: async <T>(path: string) => {
      paths.push(path);
      return {} as T;
    },
  });
  await report.daily(filter);
  await report.topProducts(filter);
  await report.stock({ from: filter.from, to: filter.to });
  assert.deepEqual(
    paths.map((path) => path.split('?')[0]),
    [
      '/api/admin/reports/daily.xlsx',
      '/api/admin/reports/top-products.xlsx',
      '/api/admin/reports/stock-movements.xlsx',
      '/api/admin/reports/daily',
      '/api/admin/reports/top-products',
      '/api/admin/reports/stock-movements',
    ],
  );
  assert.equal(new URL(paths.at(-1)!, 'http://localhost').searchParams.has('branchId'), false);
});

it('lỗi HTTP JSON 400/403/413/503 không bị tải thành Excel, 403 giữ phiên', async () => {
  for (const [status, code] of [
    [400, 'VALIDATION_FAILED'],
    [403, 'FORBIDDEN'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [503, 'SERVICE_UNAVAILABLE'],
  ] as const) {
    const { api, signals } = client(async () => json(status, { code, message: 'fixture error' }));
    await assert.rejects(
      () => fetchReportExcel(api, 'daily', filter),
      (error: unknown) =>
        error instanceof ApiError && error.status === status && error.code === code,
    );
    assert.equal(signals.lost, 0);
    assert.equal(api.hasSession(), true);
    assert.equal(signals.forbidden, status === 403 ? 1 : 0);
  }
});

it('HTTP 200 trả JSON/HTML hoặc giả MIME nhưng không phải ZIP bị từ chối', async () => {
  for (const response of [
    json(200, { error: true }),
    new Response('<html>error</html>', { headers: { 'content-type': XLSX_MIME } }),
    new Response('PK', { headers: { 'content-type': XLSX_MIME } }),
  ]) {
    const { api } = client(async () => response);
    await assert.rejects(
      () => fetchReportExcel(api, 'daily', filter),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_DOWNLOAD',
    );
    assert.equal(api.hasSession(), true);
  }
});

it('filename từ Content-Disposition chỉ nhận tên xlsx an toàn, hỗ trợ UTF-8', () => {
  assert.equal(
    excelFilename('attachment; filename="bao-cao.xlsx"', 'default.xlsx'),
    'bao-cao.xlsx',
  );
  assert.equal(
    excelFilename("attachment; filename*=UTF-8''B%C3%A1o%20c%C3%A1o.xlsx", 'default.xlsx'),
    'Báo cáo.xlsx',
  );
  for (const value of [
    '../secret.xlsx',
    'C:\\secret.xlsx',
    'report.html',
    '.hidden.xlsx',
    'report\u202exlsx.exe',
    'a\n.xlsx',
  ]) {
    assert.equal(excelFilename(`attachment; filename="${value}"`, 'default.xlsx'), 'default.xlsx');
  }
  assert.equal(
    excelFilename("attachment; filename*=UTF-8''bad%XX.xlsx", 'default.xlsx'),
    'default.xlsx',
  );
});

it('download tạo link từ Blob, click rồi dọn link/object URL, không để token trên URL', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let clicked = 0;
  let removed = 0;
  const link = { href: '', download: '', click: () => clicked++, remove: () => removed++ };
  context.mock.method(URL, 'createObjectURL', () => 'blob:report-test');
  const revoke = context.mock.method(URL, 'revokeObjectURL', () => undefined);
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => link, body: { appendChild: () => undefined } },
  });
  try {
    saveReportExcel({ blob: new Blob([zip]), filename: 'report.xlsx' });
    assert.equal(link.href, 'blob:report-test');
    assert.equal(link.download, 'report.xlsx');
    assert.equal(clicked, 1);
    assert.equal(removed, 1);
    context.mock.timers.tick(1000);
    assert.equal(revoke.mock.calls.length, 1);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
