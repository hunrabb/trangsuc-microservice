import type { ErrorCode } from '@jewelry/contracts';

/** Mã lỗi của server, cộng hai mã chỉ có phía giao diện. */
export type ApiErrorCode = ErrorCode | 'NETWORK_ERROR' | 'UNKNOWN';

export interface ApiErrorInit {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

/** Lỗi từ API, đã đọc sẵn theo định dạng `ErrorResponse` (CLAUDE.md mục 10). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: Record<string, unknown> | undefined;
  /** Từ header `Retry-After`, có khi bị `429 RATE_LIMITED`. */
  readonly retryAfterSeconds: number | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }

  /** Lỗi theo từng trường của `VALIDATION_FAILED`: `{ tên trường: thông báo }`. */
  fieldErrors(): Record<string, string> {
    const fields = this.details?.fields;
    if (!Array.isArray(fields)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const item of fields as { field?: unknown; message?: unknown }[]) {
      if (typeof item.field === 'string' && typeof item.message === 'string') {
        result[item.field] = item.message;
      }
    }
    return result;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

/** Đọc phản hồi lỗi. Body không phải JSON (proxy trả HTML...) vẫn cho ra một `ApiError` hợp lệ. */
export async function toApiError(response: Response): Promise<ApiError> {
  let body: { code?: unknown; message?: unknown; details?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // giữ body rỗng
  }
  const retryAfter = Number(response.headers.get('retry-after'));
  return new ApiError({
    status: response.status,
    code: typeof body.code === 'string' ? (body.code as ApiErrorCode) : 'UNKNOWN',
    message: typeof body.message === 'string' ? body.message : `Lỗi HTTP ${response.status}`,
    details:
      typeof body.details === 'object' && body.details !== null
        ? (body.details as Record<string, unknown>)
        : undefined,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  });
}
