import type { ItemWithPrice, PosCustomer, PosOrder } from '@jewelry/contracts';

export interface CartItem {
  tagCode: string;
  productName: string;
  variantName: string;
  weight: string;
  price: string;
}

export interface PosState {
  ownerId: string;
  branchId: string;
  key: string;
  items: CartItem[];
  customerId: string | null;
  customer: PosCustomer | null;
  orderId: string | null;
  pendingAction: 'confirm' | 'cancel' | null;
  phase: 'draft' | 'submitting' | 'uncertain' | 'ready' | 'settling' | 'closed';
}

const storageKey = (ownerId: string, branchId: string) => `backoffice.pos.${ownerId}.${branchId}`;

/** Mỗi giỏ mới có key mới; giỏ đã gửi giữ nguyên key qua timeout, reload và đăng nhập lại. */
export function newPosState(ownerId: string, branchId: string): PosState {
  return {
    ownerId,
    branchId,
    key: crypto.randomUUID(),
    items: [],
    customerId: null,
    customer: null,
    orderId: null,
    pendingAction: null,
    phase: 'draft',
  };
}

/** Dữ liệu lưu không chứa token; bỏ bản cũ/hỏng hoặc không đúng nhân viên, chi nhánh. */
export function readPosState(ownerId: string, branchId: string): PosState {
  try {
    const text = localStorage.getItem(storageKey(ownerId, branchId));
    if (text === null) return newPosState(ownerId, branchId);
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return newPosState(ownerId, branchId);
    const state = value as Partial<PosState>;
    if (
      state.ownerId !== ownerId ||
      state.branchId !== branchId ||
      typeof state.key !== 'string' ||
      !Array.isArray(state.items)
    ) {
      return newPosState(ownerId, branchId);
    }
    if (
      !['draft', 'submitting', 'uncertain', 'ready', 'settling', 'closed'].includes(
        state.phase ?? '',
      )
    ) {
      return newPosState(ownerId, branchId);
    }
    return {
      ...state,
      customer: state.customer ?? null,
      pendingAction: state.pendingAction ?? null,
    } as PosState;
  } catch {
    return newPosState(ownerId, branchId);
  }
}

/** Ghi đồng bộ trước HTTP để reload/đăng nhập lại luôn có key cũ để tra hoặc gửi lại. */
export function savePosState(state: PosState): boolean {
  try {
    localStorage.setItem(storageKey(state.ownerId, state.branchId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Chỉ cho sửa giỏ nháp; thay nội dung là một yêu cầu mới nên sinh key mới. */
export function addCartItem(state: PosState, item: ItemWithPrice): PosState {
  if (state.phase !== 'draft') return state;
  if (state.items.some((entry) => entry.tagCode === item.tagCode)) return state;
  return {
    ...state,
    key: crypto.randomUUID(),
    items: [
      ...state.items,
      {
        tagCode: item.tagCode,
        productName: item.productName,
        variantName: item.variantName,
        weight: item.weight,
        price: item.price,
      },
    ],
  };
}

/** Xoá tem khỏi giỏ nháp cũng đổi key để body cũ không bị phát lại nhầm. */
export function removeCartItem(state: PosState, tagCode: string): PosState {
  if (state.phase !== 'draft') return state;
  return {
    ...state,
    key: crypto.randomUUID(),
    items: state.items.filter((item) => item.tagCode !== tagCode),
  };
}

/** Gắn khách trước lúc gửi đơn; requestHash ở Sales sẽ bao gồm customerId. */
export function selectCustomer(state: PosState, customer: PosCustomer | null): PosState {
  if (state.phase !== 'draft') return state;
  return { ...state, customer, customerId: customer?.id ?? null, key: crypto.randomUUID() };
}

/** Sau timeout chỉ trạng thái Sales quyết định: lệnh huỷ dở vẫn là cùng thao tác, chưa mở nút thu tiền. */
export function reconcilePosState(state: PosState, order: PosOrder): PosState {
  if (
    state.orderId === order.id &&
    state.phase === 'settling' &&
    order.status === 'PENDING_PAYMENT'
  ) {
    return state;
  }
  const phase: PosState['phase'] =
    order.status === 'PENDING_PAYMENT'
      ? 'ready'
      : order.status === 'COMPLETED' || order.status === 'CANCELLED'
        ? 'closed'
        : order.status === 'CANCELLING' && state.pendingAction === 'cancel'
          ? 'settling'
          : 'uncertain';
  return {
    ...state,
    orderId: order.id,
    phase,
    pendingAction: phase === 'ready' || phase === 'closed' ? null : state.pendingAction,
  };
}
