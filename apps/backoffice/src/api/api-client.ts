import type { AuthSession } from '@jewelry/contracts';
import { ApiError, toApiError } from './api-error.ts';

/**
 * Bộ gọi API dùng chung cho toàn giao diện, và là nơi duy nhất giữ access token.
 *
 * Quy tắc phiên (docs/thiet-ke.md, mục "Xác thực"):
 * - Access token chỉ nằm trong biến của module này, không bao giờ vào localStorage hay sessionStorage.
 *   Refresh token là cookie httpOnly, JavaScript không đọc được; chỉ trình duyệt tự gửi tới /api/auth.
 * - `401 TOKEN_EXPIRED`: refresh MỘT lần dùng chung cho mọi request đang chờ, rồi gửi lại request.
 * - `401 INVALID_TOKEN` hoặc `SESSION_EXPIRED`: phiên không cứu được, xoá token và báo cho giao diện về trang
 *   đăng nhập. KHÔNG gọi refresh: refresh bằng cookie của phiên hỏng chỉ làm server coi là dùng lại token.
 * - Refresh nhận `409 REFRESH_CONFLICT` (tab khác vừa refresh, cookie mới đã có sẵn): thử lại đúng một lần.
 * - `403`: vai trò có thể vừa đổi, báo giao diện tải lại `/me`.
 * - Chủ động refresh trước khi hết hạn khoảng 1 phút.
 *
 * File này không dùng API của React hay DOM ngoài `fetch`/`Response`, để test được bằng Node.
 */

const DEFAULT_REFRESH_LEAD_SECONDS = 60;
const MIN_REFRESH_DELAY_MS = 1000;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Được gửi dạng JSON. */
  body?: unknown;
}

export interface ApiClientOptions {
  fetch: typeof fetch;
  /** Phiên đã mất: giao diện chuyển về trang đăng nhập. Có thể được gọi nhiều lần. */
  onSessionLost(): void;
  /** Bị `403`: giao diện tải lại thông tin người dùng. */
  onForbidden(): void;
  /** Đặt hẹn giờ, trả về hàm huỷ. Mặc định `setTimeout`; test truyền bản giả. */
  schedule?(callback: () => void, delayMs: number): () => void;
  refreshLeadSeconds?: number;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  /** Gọi không kèm token và không xử lý phiên: đăng nhập, đăng xuất. */
  publicRequest<T>(path: string, options?: RequestOptions): Promise<T>;
  /** Dùng token của phiên vừa đăng nhập, và hẹn refresh. */
  setSession(session: AuthSession): void;
  /** Xoá token, huỷ hẹn giờ. Không báo `onSessionLost` (người dùng tự đăng xuất). */
  clearSession(): void;
  /** Khôi phục phiên từ cookie khi mở lại trang. `null` nếu không có phiên. */
  restore(): Promise<AuthSession | null>;
  hasSession(): boolean;
}

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

export function createApiClient(options: ApiClientOptions): ApiClient {
  const schedule = options.schedule ?? defaultSchedule;
  const lead = options.refreshLeadSeconds ?? DEFAULT_REFRESH_LEAD_SECONDS;

  let accessToken: string | undefined;
  let cancelScheduled: (() => void) | undefined;
  let refreshInFlight: Promise<AuthSession> | undefined;
  // Mỗi lần đăng nhập/đăng xuất đổi thế hệ để refresh cũ không thể ghi đè session mới.
  let sessionGeneration = 0;

  async function send(
    path: string,
    { method = 'GET', body }: RequestOptions,
    token: string | undefined,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    try {
      return await options.fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError({
        status: 0,
        code: 'NETWORK_ERROR',
        message: 'Không kết nối được tới máy chủ',
      });
    }
  }

  async function readBody<T>(response: Response): Promise<T> {
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  function applySession(session: AuthSession, generation: number): void {
    if (generation !== sessionGeneration) {
      return;
    }
    accessToken = session.accessToken;
    cancelScheduled?.();
    const delayMs = Math.max(MIN_REFRESH_DELAY_MS, (session.expiresIn - lead) * 1000);
    // Refresh nền hỏng thì thôi: request kế tiếp gặp TOKEN_EXPIRED sẽ tự refresh lại.
    cancelScheduled = schedule(() => void refresh().catch(() => undefined), delayMs);
  }

  function setSession(session: AuthSession): void {
    sessionGeneration += 1;
    applySession(session, sessionGeneration);
  }

  function clearSession(): void {
    sessionGeneration += 1;
    accessToken = undefined;
    cancelScheduled?.();
    cancelScheduled = undefined;
  }

  function loseSession(): void {
    clearSession();
    options.onSessionLost();
  }

  /** Một lần refresh dùng chung: ai gọi trong lúc đang chạy đều nhận cùng kết quả. */
  function refresh(): Promise<AuthSession> {
    refreshInFlight ??= doRefresh().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  }

  async function doRefresh(): Promise<AuthSession> {
    const generation = sessionGeneration;
    for (let attempt = 1; ; attempt += 1) {
      const response = await send('/api/auth/refresh', { method: 'POST' }, undefined);
      if (response.ok) {
        const session = await readBody<AuthSession>(response);
        // Logout hoặc lần đăng nhập mới có thể xảy ra khi refresh còn đang chờ mạng.
        applySession(session, generation);
        return session;
      }
      const error = await toApiError(response);
      // Hai tab refresh cùng lúc: tab kia thắng và cookie mới đã có, gửi lại là được. Chỉ một lần.
      if (error.code === 'REFRESH_CONFLICT' && attempt === 1) {
        continue;
      }
      if (error.status === 401) {
        loseSession();
      }
      throw error;
    }
  }

  /**
   * Gọi sau khi một request bị `TOKEN_EXPIRED`. Nếu token hiện tại đã khác token request đó đã gửi thì
   * request khác vừa refresh xong, chỉ cần gửi lại bằng token mới, không refresh thêm lần nữa.
   */
  async function ensureFreshToken(sentToken: string | undefined): Promise<void> {
    if (accessToken === undefined) {
      throw new ApiError({
        status: 401,
        code: 'SESSION_EXPIRED',
        message: 'Phiên đăng nhập đã hết hạn',
      });
    }
    if (accessToken !== sentToken) {
      return;
    }
    await refresh();
  }

  /** Lỗi còn lại sau cùng. 401 do phiên hỏng thì mất phiên; 403 thì báo giao diện. */
  function fail(error: ApiError): never {
    if (error.status === 401) {
      loseSession();
    } else if (error.status === 403) {
      options.onForbidden();
    }
    throw error;
  }

  async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const sentToken = accessToken;
    let response = await send(path, init, sentToken);
    if (response.status === 401) {
      const error = await toApiError(response);
      if (error.code !== 'TOKEN_EXPIRED') {
        return fail(error);
      }
      await ensureFreshToken(sentToken);
      response = await send(path, init, accessToken);
    }
    if (!response.ok) {
      return fail(await toApiError(response));
    }
    return readBody<T>(response);
  }

  async function publicRequest<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const response = await send(path, init, undefined);
    if (!response.ok) {
      throw await toApiError(response);
    }
    return readBody<T>(response);
  }

  async function restore(): Promise<AuthSession | null> {
    try {
      return await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return null;
      }
      throw error;
    }
  }

  return {
    request,
    publicRequest,
    setSession,
    clearSession,
    restore,
    hasSession: () => accessToken !== undefined,
  };
}
