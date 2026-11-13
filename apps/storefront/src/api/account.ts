import { useSyncExternalStore } from 'react';
import {
  customerSessionSchema as sessionSchema,
  type CustomerSession as Session,
} from '@jewelry/contracts';
let session: Session | null = null;
let ready = false;
let expiresAt = 0;
let sessionUnavailable = false;
let refreshing: Promise<Session | null> | undefined;
const listeners = new Set<() => void>();
function publish(value: Session | null) {
  session = value;
  ready = true;
  expiresAt = Date.now() + (value?.expiresIn ?? 0) * 1000;
  listeners.forEach((fn) => fn());
}
export function useAccount() {
  const account = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => session,
    () => session,
  );
  const initialized = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => ready,
    () => ready,
  );
  return { account, ready: initialized };
}
class AccountAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function auth(path: string, body?: unknown) {
  const res = await fetch(`/api/shop/auth/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok)
    throw new AccountAuthError(
      res.status,
      path === 'register'
        ? 'Không thể đăng ký. Kiểm tra thông tin hoặc dùng email khác.'
        : 'Không thể đăng nhập. Kiểm tra email và mật khẩu hoặc thử lại.',
    );
  return res;
}
export async function restoreAccount() {
  if (!refreshing)
    refreshing = (async () => {
      try {
        let response: Response;
        try {
          response = await auth('refresh');
        } catch (error) {
          if (!(error instanceof AccountAuthError) || error.status !== 409) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
          response = await auth('refresh');
        }
        const value = sessionSchema.parse(await response.json());
        sessionUnavailable = false;
        publish(value);
        return value;
      } catch (error) {
        sessionUnavailable =
          !!session || !(error instanceof AccountAuthError && error.status === 401);
        publish(null);
        return null;
      } finally {
        refreshing = undefined;
      }
    })();
  return refreshing;
}
export async function accountToken() {
  if (!ready) await restoreAccount();
  if (session && expiresAt <= Date.now() + 30000) await restoreAccount();
  if (sessionUnavailable)
    throw new Error(
      'Chưa xác minh được phiên tài khoản. Vui lòng đăng nhập lại trước khi đặt hàng.',
    );
  return session?.accessToken;
}
export async function loginAccount(mode: 'login' | 'register', body: unknown) {
  const value = sessionSchema.parse(await (await auth(mode, body)).json());
  sessionUnavailable = false;
  publish(value);
}
export async function logoutAccount() {
  await auth('logout');
  sessionUnavailable = false;
  publish(null);
}
export async function accountGet<T>(
  path: string,
  schema: { parse(value: unknown): T },
  signal?: AbortSignal,
  method: 'GET' | 'POST' = 'GET',
): Promise<T> {
  const token = await accountToken();
  if (!token) throw new Error('Vui lòng đăng nhập để xem đơn hàng.');
  const res = await fetch(`/api/shop/my-orders${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    credentials: 'omit',
    signal,
    redirect: 'error',
  });
  if (res.status === 401) {
    sessionUnavailable = true;
    publish(null);
    throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  }
  if (!res.ok)
    throw new Error(
      res.status === 404
        ? 'Không tìm thấy đơn hàng thuộc tài khoản của bạn.'
        : 'Chưa tải được đơn hàng. Vui lòng thử lại.',
    );
  return schema.parse(await res.json());
}
