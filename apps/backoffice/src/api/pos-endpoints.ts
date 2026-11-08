import type {
  CreatePosCustomerRequest,
  CreatePosOrderRequest,
  PosCustomer,
  PosCustomerOrders,
  PosOrder,
} from '@jewelry/contracts';
import { api } from './instance.ts';

const POS = '/api/pos';

/** API POS dùng cùng client giữ phiên; mọi lần gửi lại đơn phải dùng đúng key ban đầu. */
export const posApi = {
  createOrder: (body: CreatePosOrderRequest, key: string) =>
    api.request<PosOrder>(`${POS}/orders`, {
      method: 'POST',
      body,
      idempotencyKey: key,
    }),
  getOrderByKey: (key: string) =>
    api.request<PosOrder>(`${POS}/orders/by-key/${encodeURIComponent(key)}`),
  getOrder: (id: string) => api.request<PosOrder>(`${POS}/orders/${id}`),
  confirmPayment: (id: string) =>
    api.request<PosOrder>(`${POS}/orders/${id}/confirm-payment`, { method: 'POST' }),
  cancelOrder: (id: string) =>
    api.request<PosOrder>(`${POS}/orders/${id}/cancel`, { method: 'POST' }),
  findCustomer: (phone: string, branchId: string) =>
    api.request<PosCustomer>(
      `${POS}/customers/by-phone/${encodeURIComponent(phone)}?branchId=${encodeURIComponent(branchId)}`,
    ),
  createCustomer: (body: CreatePosCustomerRequest) =>
    api.request<PosCustomer>(`${POS}/customers`, { method: 'POST', body }),
  customerOrders: (id: string, branchId: string) =>
    api.request<PosCustomerOrders>(
      `${POS}/customers/${id}/orders?branchId=${encodeURIComponent(branchId)}`,
    ),
};
