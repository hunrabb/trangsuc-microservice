import type { AuthSession, CurrentUser } from '@jewelry/contracts';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, setApiHandlers } from '../api/instance.ts';
import { authApi } from '../api/endpoints.ts';

/**
 * Trạng thái phiên cho cả cây React.
 * - `loading`: đang khôi phục phiên từ cookie refresh khi mở trang.
 * - `unavailable`: không hỏi được máy chủ (mất mạng...), khác với "chưa đăng nhập".
 * Access token nằm trong `api` (api-client.ts), không nằm ở đây.
 */
export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'unavailable';

interface SessionValue {
  status: SessionStatus;
  /** Thông tin mới nhất từ `/me`; có sau khi `status = authenticated` và tải xong. */
  me: CurrentUser | undefined;
  meError: boolean;
  reloadMe(): void;
  retryRestore(): void;
  loginWithGoogle(credential: string): Promise<void>;
  loginWithPassword(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === undefined) {
    throw new Error('useSession phải nằm trong SessionProvider');
  }
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [restoreAttempt, setRestoreAttempt] = useState(0);

  // Phiên mất (token hỏng, hết hạn, refresh thất bại): về anonymous, xoá dữ liệu đã tải. `RequireAuth` sẽ
  // đưa người dùng về trang đăng nhập và nhớ trang đang ở. Bị 403: vai trò có thể vừa đổi, tải lại `/me`.
  useEffect(() => {
    setApiHandlers({
      onSessionLost: () => {
        setStatus('anonymous');
        queryClient.clear();
      },
      onForbidden: () => {
        void queryClient.invalidateQueries({ queryKey: ['me'] });
        notifications.show({
          color: 'red',
          message: 'Bạn không có quyền thực hiện thao tác này.',
        });
      },
    });
  }, [queryClient]);

  // Mở lại trang: khôi phục phiên bằng cookie refresh. `restore` dùng chung một lần refresh nên chạy hai lần
  // (React StrictMode khi dev) vẫn chỉ gọi server một lần.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    api
      .restore()
      .then((session) => {
        if (!cancelled) {
          setStatus(session === null ? 'anonymous' : 'authenticated');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('unavailable');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [restoreAttempt]);

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: authApi.me,
    enabled: status === 'authenticated',
    retry: false,
  });

  const open = useCallback(
    (session: AuthSession) => {
      api.setSession(session);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      setStatus('authenticated');
    },
    [queryClient],
  );

  const value = useMemo<SessionValue>(
    () => ({
      status,
      me: meQuery.data,
      meError: meQuery.isError,
      reloadMe: () => void meQuery.refetch(),
      retryRestore: () => setRestoreAttempt((count) => count + 1),
      loginWithGoogle: async (credential) =>
        open(
          await api.publicRequest<AuthSession>('/api/auth/google', {
            method: 'POST',
            body: { credential },
          }),
        ),
      loginWithPassword: async (email, password) =>
        open(
          await api.publicRequest<AuthSession>('/api/auth/login', {
            method: 'POST',
            body: { email, password },
          }),
        ),
      logout: async () => {
        // Đăng xuất luôn thành công ở phía giao diện, kể cả khi mạng lỗi: token trong bộ nhớ bị bỏ ngay.
        await api
          .publicRequest<void>('/api/auth/logout', { method: 'POST' })
          .catch(() => undefined);
        api.clearSession();
        queryClient.clear();
        setStatus('anonymous');
      },
      logoutAll: async () => {
        await authApi.logoutAll();
        api.clearSession();
        queryClient.clear();
        setStatus('anonymous');
      },
    }),
    [status, meQuery, open, queryClient],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
