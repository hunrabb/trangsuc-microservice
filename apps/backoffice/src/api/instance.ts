import { createApiClient } from './api-client.ts';

/**
 * Giao diện React đăng ký xử lý sau khi khởi tạo (`SessionProvider`): bộ gọi API sống ở ngoài cây React
 * nên không tự biết cách điều hướng hay hiện thông báo.
 */
const handlers = { onSessionLost: () => undefined, onForbidden: () => undefined } as {
  onSessionLost(): void;
  onForbidden(): void;
};

export function setApiHandlers(next: typeof handlers): void {
  handlers.onSessionLost = next.onSessionLost;
  handlers.onForbidden = next.onForbidden;
}

/** Bộ gọi API duy nhất của ứng dụng. */
export const api = createApiClient({
  fetch: (input, init) => window.fetch(input, init),
  onSessionLost: () => handlers.onSessionLost(),
  onForbidden: () => handlers.onForbidden(),
});
