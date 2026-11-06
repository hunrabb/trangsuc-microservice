import { useEffect, useState } from 'react';

const APP_NAME = 'Storefront';
const APP_DESCRIPTION = 'Website bán hàng cho khách';

type PingState =
  { status: 'loading' } | { status: 'ok'; body: unknown } | { status: 'error'; message: string };

export function App() {
  const [ping, setPing] = useState<PingState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/ping', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        setPing({ status: 'ok', body: await response.json() });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPing({ status: 'error', message: String(error) });
        }
      });

    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>{APP_DESCRIPTION}</p>
      <h2>
        <code>GET /api/ping</code>
      </h2>
      {ping.status === 'loading' && <p>Đang gọi…</p>}
      {ping.status === 'ok' && <pre data-testid="ping-result">{JSON.stringify(ping.body)}</pre>}
      {ping.status === 'error' && <pre data-testid="ping-error">Lỗi: {ping.message}</pre>}
    </main>
  );
}
