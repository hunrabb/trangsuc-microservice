/** Bảng định tuyến của gateway (CLAUDE.md mục 10). Quy tắc viết lại đường dẫn: xem README. */
export type UpstreamService = 'auth' | 'inventory' | 'sales' | 'report';

export interface ProxyRoute {
  /** Khớp theo đoạn đường dẫn: `/api/pos` khớp `/api/pos/x`, không khớp `/api/posx`. */
  prefix: string;
  service: UpstreamService;
  /** Phần bị bỏ khỏi đầu đường dẫn khi chuyển tiếp. */
  strip: string;
}

export const PROXY_ROUTES: readonly ProxyRoute[] = [
  { prefix: '/api/pos', service: 'sales', strip: '/api' },
  { prefix: '/api/shop', service: 'sales', strip: '/api' },
  { prefix: '/api/online-orders', service: 'sales', strip: '/api' },
  { prefix: '/api/admin/auth', service: 'auth', strip: '/api/admin/auth' },
  { prefix: '/api/admin/inventory', service: 'inventory', strip: '/api/admin/inventory' },
  { prefix: '/api/admin/sales', service: 'sales', strip: '/api/admin/sales' },
  { prefix: '/api/admin/reports', service: 'report', strip: '/api/admin/reports' },
  { prefix: '/webhooks/bank', service: 'sales', strip: '' },
];

/** Đoạn đầu của đường dẫn phía service không bao giờ được gateway chuyển tới. */
const BLOCKED_FIRST_SEGMENT = 'internal';

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Chặn mọi cách đi vòng sau khi cắt tiền tố: `..`, `%2e%2e`, `%2f`, `\`, `//` (trình phân tích URL coi
 * `//x/y` là host `x`). Đường dẫn bình thường không có các dạng này nên từ chối hẳn thay vì chuẩn hoá.
 */
function isSafePath(path: string): boolean {
  const segments = path.split('/').slice(1);
  return segments.every((segment, index) => {
    if (segment === '') {
      return index === segments.length - 1;
    }
    const decoded = decodeSegment(segment);
    return decoded !== undefined && decoded !== '.' && decoded !== '..' && !/[/\\\0]/.test(decoded);
  });
}

function isBlocked(path: string): boolean {
  const first = decodeSegment(path.split('/')[1] ?? '');
  return first?.toLowerCase() === BLOCKED_FIRST_SEGMENT;
}

export interface ResolvedRoute {
  service: UpstreamService;
  /** Đường dẫn + query gửi tới service, luôn bắt đầu bằng một dấu `/`. */
  path: string;
}

/** Tìm đích chuyển tiếp cho URL thô của request; không khớp hoặc không an toàn → `undefined`. */
export function resolveRoute(
  rawUrl: string,
  routes: readonly ProxyRoute[] = PROXY_ROUTES,
): ResolvedRoute | undefined {
  const queryStart = rawUrl.indexOf('?');
  const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const query = queryStart === -1 ? '' : rawUrl.slice(queryStart);

  const route = routes.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
  if (route === undefined) {
    return undefined;
  }
  const rewritten = path.slice(route.strip.length) || '/';
  if (!isSafePath(rewritten) || isBlocked(rewritten)) {
    return undefined;
  }
  return { service: route.service, path: `${rewritten}${query}` };
}
