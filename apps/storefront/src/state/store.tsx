import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueries } from '@tanstack/react-query';
import { shopApi, canRetryRead, type ShopProduct } from '../api/shop.ts';
import {
  addCartItem,
  persistCart,
  readCart,
  setCartQuantity,
  inspectCart,
  type CartItem,
  type StoragePort,
} from './cart.ts';
import { CheckoutCoordinator, CheckoutVault } from './checkout.ts';

function browserStorage(key: 'localStorage' | 'sessionStorage'): StoragePort | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window[key];
  } catch {
    return undefined;
  }
}
type StoreValue = {
  cart: CartItem[];
  notice: string;
  storageAvailable: boolean;
  announce(message: string): void;
  add(product: ShopProduct, variantId: string, quantity: number): void;
  quantity(item: CartItem, quantity: number): void;
  vault: CheckoutVault;
  coordinator: CheckoutCoordinator;
  refreshSession(): void;
  sessionRevision: number;
};
const StoreContext = createContext<StoreValue | null>(null);
export function StoreProvider({ children }: { children: ReactNode }) {
  const [storage] = useState(() => browserStorage('localStorage'));
  const [cart, setCart] = useState(() => readCart(storage));
  const ref = useRef(cart);
  const [notice, announce] = useState('');
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [vault] = useState(() => new CheckoutVault(browserStorage('sessionStorage')));
  const [coordinator] = useState(() => new CheckoutCoordinator(shopApi, vault));
  const [sessionRevision, setRevision] = useState(0);
  const refreshSession = useCallback(() => setRevision((v) => v + 1), []);
  const commit = useCallback(
    (next: CartItem[]) => {
      ref.current = next;
      setCart(next);
      setStorageAvailable(persistCart(storage, next));
    },
    [storage],
  );
  const add = useCallback(
    (product: ShopProduct, variantId: string, quantity: number) => {
      try {
        commit(addCartItem(ref.current, product, variantId, quantity));
        announce('Đã thêm sản phẩm vào giỏ của bạn.');
      } catch (error) {
        throw new Error(
          error instanceof Error && !('issues' in error)
            ? error.message
            : 'Giỏ tối đa 20 lựa chọn, 10 chiếc mỗi lựa chọn và 50 chiếc tất cả.',
          { cause: error },
        );
      }
    },
    [commit],
  );
  const quantity = useCallback(
    (item: CartItem, quantity: number) => commit(setCartQuantity(ref.current, item, quantity)),
    [commit],
  );
  const value = useMemo(
    () => ({
      cart,
      notice,
      storageAvailable,
      announce,
      add,
      quantity,
      vault,
      coordinator,
      refreshSession,
      sessionRevision,
    }),
    [
      cart,
      notice,
      storageAvailable,
      add,
      quantity,
      vault,
      coordinator,
      refreshSession,
      sessionRevision,
    ],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
export function useStore(): StoreValue {
  const state = useContext(StoreContext);
  if (!state) throw new Error('Thiếu StoreProvider');
  return state;
}
export function useCartProducts() {
  const { cart } = useStore();
  const ids = [...new Set(cart.map((item) => item.productId))];
  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['product', id],
      queryFn: ({ signal }: { signal: AbortSignal }) => shopApi.product(id, signal),
      staleTime: 30_000,
      retry: canRetryRead,
    })),
  });
  const products = new Map(
    queries.flatMap((query, i) => (query.data ? [[ids[i], query.data] as const] : [])),
  );
  return {
    ...inspectCart(cart, products),
    loading: queries.some((query) => query.isPending),
    error: queries.some((query) => query.isError),
    refreshing: queries.some((query) => query.isFetching),
    retry: () => Promise.all(queries.map((query) => query.refetch())),
  };
}
