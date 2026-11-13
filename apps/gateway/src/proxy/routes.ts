import type { TokenAudience } from '@jewelry/contracts';

/** Bảng định tuyến của gateway (CLAUDE.md mục 10). Quy tắc viết lại đường dẫn: xem README. */
export type UpstreamService = 'auth' | 'inventory' | 'sales' | 'report';

export interface ProxyRoute {
  /** Khớp theo đoạn đường dẫn: `/api/pos` khớp `/api/pos/x`, không khớp `/api/posx`. */
  prefix: string;
  service: UpstreamService;
  /** Thay `prefix` bằng chuỗi này khi chuyển tiếp. */
  rewriteTo: string;
  /** Loại token gateway yêu cầu; `null` = công khai ở gateway (service vẫn có thể tự kiểm). */
  audience: TokenAudience | null;
  /** Chỉ khớp đúng `prefix`, không nhận đường con. */
  exact?: boolean;
}

/** Khớp theo thứ tự: tiền tố dài phải đứng trước tiền tố ngắn của nó (`/api/shop/auth` trước `/api/shop`). */
export const PROXY_ROUTES: readonly ProxyRoute[] = [
  // Xác thực nhân viên: /api/auth/... → Auth /auth/... (Gateway không yêu cầu token).
  // Ví dụ: /api/auth/login khớp object này → Auth /auth/login.
  {
    prefix: '/api/auth', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'auth', // Service nhận request từ Gateway.
    rewriteTo: '/auth', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: null, // Gateway không yêu cầu JWT; service vẫn tự kiểm quyền.
  },
  // Bán tại quầy: /api/pos/... → Sales /pos/... (token nhân viên).
  // Ví dụ: /api/pos/orders khớp object này → Sales /pos/orders.
  {
    prefix: '/api/pos', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'sales', // Service nhận request từ Gateway.
    rewriteTo: '/pos', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: 'backoffice', // Yêu cầu access token nhân viên.
  },
  // Nhân viên xử lý đơn online: /api/online-orders/... → Sales /online-orders/... (token nhân viên).
  // Ví dụ: /api/online-orders/123 khớp object này → Sales /online-orders/123.
  {
    prefix: '/api/online-orders', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'sales', // Service nhận request từ Gateway.
    rewriteTo: '/online-orders', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: 'backoffice', // Yêu cầu access token nhân viên.
  },
  // Xác thực khách hàng: /api/shop/auth/... → Auth /shop/auth/... (Gateway không yêu cầu token).
  // Ví dụ: /api/shop/auth/login khớp object này trước /api/shop → Auth /shop/auth/login.
  {
    prefix: '/api/shop/auth', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'auth', // Service nhận request từ Gateway.
    rewriteTo: '/shop/auth', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: null, // Gateway không yêu cầu JWT; service vẫn tự kiểm quyền.
  },
  // Đơn của khách đã đăng nhập: /api/shop/my-orders/... → Sales /shop/my-orders/... (token khách hàng).
  // Ví dụ: /api/shop/my-orders/123 khớp object này trước /api/shop → Sales /shop/my-orders/123.
  {
    prefix: '/api/shop/my-orders', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'sales', // Service nhận request từ Gateway.
    rewriteTo: '/shop/my-orders', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: 'shop', // Yêu cầu access token khách hàng.
  },
  // API website khách hàng: /api/shop/... → Sales /shop/... (service tự kiểm quyền từng endpoint).
  // Ví dụ: /api/shop/products khớp object này → Sales /shop/products.
  {
    prefix: '/api/shop', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'sales', // Service nhận request từ Gateway.
    rewriteTo: '/shop', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: null, // Gateway không yêu cầu JWT; service vẫn tự kiểm quyền.
  },
  // Quản trị chi nhánh, nhân viên: /api/admin/auth/... → Auth /admin/... (token nhân viên).
  // Ví dụ: /api/admin/auth/users khớp object này → Auth /admin/users.
  {
    prefix: '/api/admin/auth', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'auth', // Service nhận request từ Gateway.
    rewriteTo: '/admin', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: 'backoffice', // Yêu cầu access token nhân viên.
  },
  // Quản trị hàng hoá, kho: /api/admin/inventory/... → Inventory /admin/... (token nhân viên).
  // Ví dụ: /api/admin/inventory/items khớp object này → Inventory /admin/items.
  {
    prefix: '/api/admin/inventory', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'inventory', // Service nhận request từ Gateway.
    rewriteTo: '/admin', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: 'backoffice', // Yêu cầu access token nhân viên.
  },
  // Quản trị bán hàng: /api/admin/sales/... → Sales /admin/... (token nhân viên).
  // Ví dụ: /api/admin/sales/buybacks khớp object này → Sales /admin/buybacks.
  {
    prefix: '/api/admin/sales', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'sales', // Service nhận request từ Gateway.
    rewriteTo: '/admin', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: 'backoffice', // Yêu cầu access token nhân viên.
  },
  // Báo cáo: /api/admin/reports/... → Report /admin/... (token nhân viên).
  // Ví dụ: /api/admin/reports/revenue khớp object này → Report /admin/revenue.
  {
    prefix: '/api/admin/reports', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'report', // Service nhận request từ Gateway.
    rewriteTo: '/admin', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: 'backoffice', // Yêu cầu access token nhân viên.
  },
  // Webhook ngân hàng: /webhooks/bank → Sales /webhooks/bank (chỉ khớp đúng đường dẫn).
  // Ví dụ: /webhooks/bank khớp; /webhooks/bank/123 không khớp object này vì exact: true.
  {
    prefix: '/webhooks/bank', // Khớp URL bắt đầu bằng tiền tố này, theo đoạn đường dẫn.
    service: 'sales', // Service nhận request từ Gateway.
    rewriteTo: '/webhooks/bank', // Thay prefix bằng đường này; giữ phần URL phía sau.
    audience: null, // Gateway không yêu cầu JWT; service vẫn tự kiểm quyền.
    exact: true, // Chỉ khớp đúng prefix, không nhận đường dẫn con.
  },
];

/** Đoạn đầu đường dẫn phía service mà gateway không bao giờ chuyển tới. */
const BLOCKED_FIRST_SEGMENTS = new Set(['internal', 'health']);

/** Giải mã một đoạn đường dẫn; mã hoá hỏng trả `undefined` để bị từ chối. */
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

/** Đường bắt đầu bằng `/internal` hoặc `/health`, kể cả viết hoa hay mã hoá. */
function isBlocked(path: string): boolean {
  const first = decodeSegment(path.split('/')[1] ?? '');
  return first !== undefined && BLOCKED_FIRST_SEGMENTS.has(first.toLowerCase());
}

export interface ResolvedRoute {
  service: UpstreamService;
  /** Đường dẫn + query gửi tới service, luôn bắt đầu bằng một dấu `/`. */
  path: string;
  audience: TokenAudience | null;
}

/** Khớp theo đoạn đường dẫn, không theo tiền tố chuỗi: `/api/pos` không khớp `/api/posx`. */
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
    audience: route.audience,
  };
}
