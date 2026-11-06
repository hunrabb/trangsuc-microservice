import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ErrorResponse, errorResponseSchema } from '@jewelry/contracts';
import { Logger } from '@nestjs/common';
import { CORRELATION_ID_HEADER, getCorrelationId } from '../correlation/correlation-id';
import { BusinessError } from '../errors/business-error';
import { UNAVAILABLE_MESSAGE, codeForStatus } from '../errors/error-mapping';

export const DEFAULT_TIMEOUT_MS = 3000;
/** Tổng cộng tối đa 3 lượt gọi: lần đầu + 2 lần thử lại. */
export const RETRY_DELAYS_MS: readonly number[] = [100, 300];

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

export interface InternalRequest {
  url: string | URL;
  method?: string;
  /** Gửi dạng JSON. */
  body?: unknown;
  /** Giá trị header `Authorization` cần chuyển tiếp. */
  authorization?: string;
  timeoutMs?: number;
  /** Khai báo gọi lại an toàn, cho phép retry method khác GET/HEAD (ví dụ `deduct` theo `orderId`). */
  idempotent?: boolean;
}

class TransientFailure extends Error {}

function buildHeaders({ body, authorization }: InternalRequest): Record<string, string> {
  return {
    accept: 'application/json',
    [CORRELATION_ID_HEADER]: getCorrelationId() ?? randomUUID(),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(authorization === undefined ? {} : { authorization }),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toClientError(status: number, text: string, label: string): BusinessError {
  const parsed = errorResponseSchema.safeParse(parseJson(text));
  if (parsed.success) {
    const { code, message, details } = parsed.data satisfies ErrorResponse;
    return new BusinessError(code, message, status, details);
  }
  return new BusinessError(codeForStatus(status), `${label} từ chối yêu cầu`, status);
}

async function attempt<T>(request: InternalRequest, method: string, label: string): Promise<T> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(request.url, {
      method,
      headers: buildHeaders(request),
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: 'error',
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    // fetch chỉ báo "fetch failed", lý do thật (ECONNREFUSED...) nằm ở `cause`.
    throw new TransientFailure(String(error instanceof Error ? (error.cause ?? error) : error));
  }

  if (response.ok) {
    if (text === '') {
      return undefined as T;
    }
    const data = parseJson(text);
    if (data === undefined) {
      throw new Error(`${label} trả về nội dung không phải JSON`);
    }
    return data as T;
  }
  if (TRANSIENT_STATUSES.has(response.status)) {
    throw new TransientFailure(`HTTP ${response.status}`);
  }
  if (response.status >= 500) {
    throw new Error(`HTTP ${response.status}`);
  }
  throw toClientError(response.status, text, label);
}

/**
 * Gọi service khác trong mạng nội bộ, trả về body JSON đã parse.
 * Lỗi 4xx của service được ném lại cùng mã, cùng status; 5xx, timeout, mất kết nối → `503 SERVICE_UNAVAILABLE`.
 * Chỉ retry lỗi tạm thời (mạng, timeout, 502/503/504) và chỉ với GET/HEAD hoặc khi khai báo `idempotent`.
 */
export async function callInternal<T = unknown>(request: InternalRequest): Promise<T> {
  const method = (request.method ?? 'GET').toUpperCase();
  const label = new URL(request.url).host;
  const logger = new Logger('InternalHttpClient');
  const retryable = SAFE_METHODS.has(method) || request.idempotent === true;
  const delays = retryable ? RETRY_DELAYS_MS : [];

  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt<T>(request, method, label);
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      const delay = error instanceof TransientFailure ? delays[tries] : undefined;
      if (delay === undefined) {
        logger.error(`Gọi ${method} ${label} thất bại: ${String(error)}`);
        throw new BusinessError('SERVICE_UNAVAILABLE', UNAVAILABLE_MESSAGE, 503);
      }
      logger.warn(`Gọi ${method} ${label} lỗi tạm thời, thử lại: ${String(error)}`);
      await sleep(delay);
    }
  }
}
