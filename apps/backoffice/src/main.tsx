import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { isApiError } from './api/api-error.ts';
import { App } from './App';
import { SessionProvider } from './auth/session-context.tsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Chỉ thử lại khi lỗi mạng hoặc 5xx, và đúng một lần. Lỗi 4xx thử lại cũng vô ích.
      retry: (failures, error) =>
        failures < 1 && (!isApiError(error) || error.status === 0 || error.status >= 500),
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('Không tìm thấy phần tử #root');
}

createRoot(root).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="light">
      <Notifications position="top-right" />
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SessionProvider>
            <App />
          </SessionProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
