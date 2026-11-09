import type { DeadLetterMessage, DeadLetterPage, DeadLetterReplayResult } from '@jewelry/contracts';
import { api } from './instance.ts';

const BASE = '/api/admin/reports/dlq';

/** Các thao tác quản trị DLQ; browser không kết nối trực tiếp tới RabbitMQ. */
export const dlqApi = {
  list: (params: {
    page: number;
    pageSize: number;
    service?: string;
    eventType?: string;
    status?: string;
  }) => {
    const search = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    if (params.service) search.set('service', params.service);
    if (params.eventType) search.set('eventType', params.eventType);
    if (params.status) search.set('status', params.status);
    return api.request<DeadLetterPage>(`${BASE}?${search.toString()}`);
  },
  detail: (id: string) => api.request<DeadLetterMessage>(`${BASE}/${encodeURIComponent(id)}`),
  replay: (id: string) =>
    api.request<DeadLetterReplayResult>(`${BASE}/${encodeURIComponent(id)}/replay`, {
      method: 'POST',
    }),
};
