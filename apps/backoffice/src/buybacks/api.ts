import {
  buybackAppraisalsSchema,
  buybackPageSchema,
  buybackPolicySchema,
  buybackQuotesSchema,
  type AppraisalInput,
  type BuybackDetail,
  type BuybackQuery,
  type BuybackQuote,
  type BuybackQuoteInput,
  type CreateBuyback,
  type UpdateBuyback,
  type CreateSettlement,
  type CreateExchange,
  type RecordSettlementPayment,
  type ConfirmSettlementPayment,
  type CancelSettlement,
  type SettlementView,
} from '@jewelry/contracts';
import { api } from '../api/instance.ts';

export type BuybackPage = ReturnType<typeof buybackPageSchema.parse>;
export type BuybackAppraisals = ReturnType<typeof buybackAppraisalsSchema.parse>;
export type BuybackQuotes = ReturnType<typeof buybackQuotesSchema.parse>;
export type BuybackPolicy = ReturnType<typeof buybackPolicySchema.parse>;

const base = (branchId: string) =>
  `/api/admin/sales/branches/${encodeURIComponent(branchId)}/buybacks`;
const intake = (branchId: string, id: string) => `${base(branchId)}/${encodeURIComponent(id)}`;
const key = (idempotencyKey: string) => ({ idempotencyKey });

export const buybackApi = {
  list: (branchId: string, query: BuybackQuery) => {
    const search = new URLSearchParams();
    search.set('page', String(query.page));
    search.set('pageSize', String(query.pageSize));
    if (query.status) search.set('status', query.status);
    if (query.from) search.set('from', query.from);
    if (query.to) search.set('to', query.to);
    return api.request<BuybackPage>(`${base(branchId)}?${search}`);
  },
  get: (branchId: string, id: string) => api.request<BuybackDetail>(intake(branchId, id)),
  byKey: (branchId: string, idempotencyKey: string) =>
    api.request<BuybackDetail>(`${base(branchId)}/by-key`, key(idempotencyKey)),
  create: (branchId: string, body: CreateBuyback, idempotencyKey: string) =>
    api.request<BuybackDetail>(base(branchId), {
      method: 'POST',
      body,
      ...key(idempotencyKey),
    }),
  update: (branchId: string, id: string, body: UpdateBuyback) =>
    api.request<BuybackDetail>(intake(branchId, id), { method: 'PUT', body }),
  submit: (branchId: string, id: string, version: number) =>
    api.request<BuybackDetail>(`${intake(branchId, id)}/submit`, {
      method: 'POST',
      body: { version },
    }),
  cancel: (branchId: string, id: string, version: number, reason: string) =>
    api.request<BuybackDetail>(`${intake(branchId, id)}/cancel`, {
      method: 'POST',
      body: { version, reason },
    }),
  appraisals: (branchId: string, id: string) =>
    api.request<BuybackAppraisals>(`${intake(branchId, id)}/appraisals`),
  appraise: (
    branchId: string,
    id: string,
    itemId: string,
    body: AppraisalInput,
    idempotencyKey: string,
  ) =>
    api.request<BuybackAppraisals['items'][number]>(
      `${intake(branchId, id)}/items/${encodeURIComponent(itemId)}/appraisal`,
      {
        method: 'PUT',
        body,
        ...key(idempotencyKey),
      },
    ),
  policies: (branchId: string) => api.request<BuybackPolicy[]>(`${base(branchId)}/price-policies`),
  quotes: (branchId: string, id: string) =>
    api.request<BuybackQuotes>(`${intake(branchId, id)}/quotes`),
  quote: (branchId: string, id: string, body: BuybackQuoteInput, idempotencyKey: string) =>
    api.request<BuybackQuote>(`${intake(branchId, id)}/quotes`, {
      method: 'POST',
      body,
      ...key(idempotencyKey),
    }),
  decide: (
    branchId: string,
    id: string,
    quoteId: string,
    body: { version: number; reason?: string },
    approve: boolean,
    idempotencyKey: string,
  ) =>
    api.request<BuybackQuote>(
      `${intake(branchId, id)}/quotes/${encodeURIComponent(quoteId)}/${approve ? 'approve' : 'reject'}`,
      {
        method: 'POST',
        body,
        ...key(idempotencyKey),
      },
    ),
  settlement: (branchId: string, id: string) =>
    api.request<SettlementView | null>(`${intake(branchId, id)}/settlements`),
  createSettlement: (
    branchId: string,
    id: string,
    body: CreateSettlement,
    idempotencyKey: string,
  ) =>
    api.request<SettlementView>(`${intake(branchId, id)}/settlements`, {
      method: 'POST',
      body,
      ...key(idempotencyKey),
    }),
  createExchange: (branchId: string, id: string, body: CreateExchange, idempotencyKey: string) =>
    api.request<SettlementView>(`${intake(branchId, id)}/exchanges`, {
      method: 'POST',
      body,
      ...key(idempotencyKey),
    }),
  recordPayment: (
    branchId: string,
    id: string,
    settlementId: string,
    body: RecordSettlementPayment,
    idempotencyKey: string,
  ) =>
    api.request<SettlementView>(
      `${intake(branchId, id)}/settlements/${encodeURIComponent(settlementId)}/payment`,
      { method: 'POST', body, ...key(idempotencyKey) },
    ),
  confirmPayment: (
    branchId: string,
    id: string,
    settlementId: string,
    body: ConfirmSettlementPayment,
    idempotencyKey: string,
  ) =>
    api.request<SettlementView>(
      `${intake(branchId, id)}/settlements/${encodeURIComponent(settlementId)}/confirm`,
      { method: 'POST', body, ...key(idempotencyKey) },
    ),
  cancelSettlement: (
    branchId: string,
    id: string,
    settlementId: string,
    body: CancelSettlement,
    idempotencyKey: string,
  ) =>
    api.request<SettlementView>(
      `${intake(branchId, id)}/settlements/${encodeURIComponent(settlementId)}/cancel`,
      { method: 'POST', body, ...key(idempotencyKey) },
    ),
};
