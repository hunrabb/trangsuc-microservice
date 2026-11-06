/** Bảng định tuyến của gateway (CLAUDE.md mục 10). Quy tắc viết lại đường dẫn: xem README. */
export type UpstreamService = 'auth' | 'inventory' | 'sales' | 'report';

export interface ProxyRoute {
  /** Khớp theo đoạn đường dẫn: `/api/pos` khớp `/api/pos/x`, không khớp `/api/posx`. */
  prefix: string;
  service: UpstreamService;
  /** Thay `prefix` bằng chuỗi này khi chuyển tiếp. */
  rewriteTo: string;
  requiresAuth: boolean;
  /** Chỉ khớp đúng `prefix`, không nhận đường con. */
  exact?: boolean;
}

export const PROXY_ROUTES: readonly ProxyRoute[] = [
  { prefix: '/api/auth', service: 'auth', rewriteTo: '/auth', requiresAuth: false },
  { prefix: '/api/pos', service: 'sales', rewriteTo: '/pos', requiresAuth: true },
  {
    prefix: '/api/online-orders',
    service: 'sales',
    rewriteTo: '/online-orders',
    requiresAuth: true,
  },
  { prefix: '/api/shop', service: 'sales', rewriteTo: '/shop', requiresAuth: false },
  { prefix: '/api/admin/auth', service: 'auth', rewriteTo: '/admin', requiresAuth: true },
  { prefix: '/api/admin/inventory', service: 'inventory', rewriteTo: '/admin', requiresAuth: true },
  { prefix: '/api/admin/sales', service: 'sales', rewriteTo: '/admin', requiresAuth: true },
  { prefix: '/api/admin/reports', service: 'report', rewriteTo: '/admin', requiresAuth: true },
  {
    prefix: '/webhooks/bank',
    service: 'sales',
    rewriteTo: '/webhooks/bank',
    requiresAuth: false,
    exact: true,
  },
];

/** Đoạn đầu đường dẫn phía service mà gateway không bao giờ chuyển tới. */
const BLOCKED_FIRST_SEGMENTS = new Set(['internal', 'health']);

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
  return first !== undefined && BLOCKED_FIRST_SEGMENTS.has(first.toLowerCase());
}

export interface ResolvedRoute {
  service: UpstreamService;
  /** Đường dẫn + query gửi tới service, luôn bắt đầu bằng một dấu `/`. */
  path: string;
  requiresAuth: boolean;
}

function matches(route: ProxyRoute, path: string): boolean {
  return path === route.prefix || (!route.exact && path.startsWith(`${route.prefix}/`));
}

/**
 * Tìm đích chuyển tiếp cho URL thô của request; không khớp hoặc không an toàn → `undefined`.
 * Kiểm tra cả phần sau tiền tố lẫn đường đã viết lại: `/api/admin/inventory/health/ready` viết lại thành
 * `/admin/health/ready`, không bắt đầu bằng `/health` nhưng vẫn phải bị chặn.
 */
export function resolveRoute(
  rawUrl: string,
  routes: readonly ProxyRoute[] = PROXY_ROUTES,
): ResolvedRoute | undefined {
  const queryStart = rawUrl.indexOf('?');
  const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const query = queryStart === -1 ? '' : rawUrl.slice(queryStart);

  const route = routes.find((candidate) => matches(candidate, path));
  if (route === undefined) {
    return undefined;
  }
  const remainder = path.slice(route.prefix.length);
  const rewritten = `${route.rewriteTo}${remainder}`;
  if (!isSafePath(rewritten) || isBlocked(remainder) || isBlocked(rewritten)) {
    return undefined;
  }
  return {
    service: route.service,
    path: `${rewritten}${query}`,
    requiresAuth: route.requiresAuth,
  };
}
