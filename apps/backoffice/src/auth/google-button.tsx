import { Alert, Loader, Stack } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { GOOGLE_CLIENT_ID } from '../config.ts';

/** Phần của Google Identity Services mà ta dùng. */
interface GoogleIdentity {
  accounts: {
    id: {
      initialize(config: {
        client_id: string;
        callback(response: { credential?: string }): void;
      }): void;
      renderButton(element: HTMLElement, options: Record<string, unknown>): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
let scriptPromise: Promise<GoogleIdentity> | undefined;

/** Nạp script của Google một lần cho cả ứng dụng. Lỗi mạng thì lần sau thử nạp lại. */
function loadGoogleScript(): Promise<GoogleIdentity> {
  scriptPromise ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () =>
      window.google === undefined ? reject(new Error('Thiếu google')) : resolve(window.google);
    script.onerror = () => reject(new Error('Không nạp được script Google'));
    document.head.append(script);
  }).catch((error: unknown) => {
    scriptPromise = undefined;
    throw error;
  });
  return scriptPromise;
}

/**
 * Nút "Đăng nhập bằng Google" do Google vẽ. Google trả ID token (`credential`) cho `onCredential`, nơi gọi
 * `POST /api/auth/google`. Thiếu Client ID hoặc không nạp được Google thì báo rõ, trang đăng nhập vẫn dùng được.
 */
export function GoogleButton({ onCredential }: { onCredential(credential: string): void }) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  callback.current = onCredential;
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    if (GOOGLE_CLIENT_ID === undefined) {
      return;
    }
    const clientId = GOOGLE_CLIENT_ID;
    let cancelled = false;
    loadGoogleScript()
      .then((google) => {
        if (cancelled || container.current === null) {
          return;
        }
        google.accounts.id.initialize({
          client_id: clientId,
          callback: ({ credential }) => {
            if (credential !== undefined) {
              callback.current(credential);
            }
          },
        });
        google.accounts.id.renderButton(container.current, {
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          locale: 'vi',
          width: 300,
        });
        setState('ready');
      })
      .catch(() => !cancelled && setState('failed'));
    return () => {
      cancelled = true;
    };
  }, []);

  if (GOOGLE_CLIENT_ID === undefined) {
    return (
      <Alert color="yellow" title="Chưa cấu hình đăng nhập Google">
        Thiếu <code>GOOGLE_CLIENT_ID</code> trong <code>.env</code> khi chạy hoặc build giao diện.
        Bạn vẫn có thể dùng mục “Đăng nhập quản trị” bên dưới.
      </Alert>
    );
  }
  return (
    <Stack align="center" gap="xs">
      {state === 'loading' && <Loader size="sm" />}
      {state === 'failed' && (
        <Alert color="red" title="Không tải được Google">
          Không kết nối được tới Google. Hãy kiểm tra mạng rồi tải lại trang.
        </Alert>
      )}
      <div ref={container} />
    </Stack>
  );
}
