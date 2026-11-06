import type { IncomingHttpHeaders } from 'node:http';

/** RFC 9110: chỉ có nghĩa trên một chặng, không được chuyển tiếp. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * `host`, `content-length`, `expect` do fetch tự đặt; `x-correlation-id` được gắn lại bằng mã của request.
 * `x-forwarded-for` của client không đáng tin: gateway đặt lại theo địa chỉ thật của kết nối.
 */
const REQUEST_DROPPED = new Set([
  ...HOP_BY_HOP,
  'host',
  'content-length',
  'expect',
  'x-forwarded-for',
]);

/** fetch đã giải nén body nên `content-encoding`, `content-length` của service không còn đúng. */
const RESPONSE_DROPPED = new Set([
  ...HOP_BY_HOP,
  'content-encoding',
  'content-length',
  'x-correlation-id',
]);

/** Các header mà `Connection` của client liệt kê cũng là hop-by-hop. */
function listedInConnection(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(joined.split(',').map((name) => name.trim().toLowerCase()));
}

export function forwardRequestHeaders(
  incoming: IncomingHttpHeaders,
  correlationId: string,
  clientIp?: string,
): Record<string, string> {
  const listed = listedInConnection(incoming.connection);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      REQUEST_DROPPED.has(lower) ||
      listed.has(lower) ||
      lower.startsWith('x-user-')
    ) {
      continue;
    }
    headers[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers['x-correlation-id'] = correlationId;
  if (clientIp !== undefined) {
    headers['x-forwarded-for'] = clientIp;
  }
  return headers;
}

/** `set-cookie` phải giữ thành nhiều dòng riêng, không được gộp. */
export function forwardResponseHeaders(upstream: Headers): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  upstream.forEach((value, name) => {
    if (!RESPONSE_DROPPED.has(name) && name !== 'set-cookie') {
      headers[name] = value;
    }
  });
  const cookies = upstream.getSetCookie();
  if (cookies.length > 0) {
    headers['set-cookie'] = cookies;
  }
  return headers;
}
