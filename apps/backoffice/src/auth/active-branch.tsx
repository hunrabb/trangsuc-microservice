import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { useSession } from './session-context.tsx';

/**
 * Chi nhánh đang làm việc, cho người có vai trò ở chi nhánh (MANAGER, STAFF). ADMIN không có chi nhánh riêng.
 * Chỉ nhớ id chi nhánh trong localStorage (không phải bí mật); đọc ghi đều có thể lỗi (chế độ riêng tư).
 */
const STORAGE_KEY = 'backoffice.activeBranchId';

const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeStored = (branchId: string): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, branchId);
  } catch {
    // không nhớ được thì lần sau chọn lại
  }
};

interface ActiveBranchValue {
  /** Các chi nhánh người dùng có vai trò. */
  branchIds: string[];
  /** Chi nhánh đang chọn; `null` nếu không có vai trò nào ở chi nhánh. */
  activeBranchId: string | null;
  setActiveBranchId(branchId: string): void;
}

const ActiveBranchContext = createContext<ActiveBranchValue | undefined>(undefined);

export function useActiveBranch(): ActiveBranchValue {
  const value = useContext(ActiveBranchContext);
  if (value === undefined) {
    throw new Error('useActiveBranch phải nằm trong ActiveBranchProvider');
  }
  return value;
}

export function ActiveBranchProvider({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const [stored, setStored] = useState<string | null>(readStored);

  const branchIds = useMemo(
    () => [
      ...new Set(
        (me?.branches ?? []).flatMap(({ branchId }) => (branchId === null ? [] : [branchId])),
      ),
    ],
    [me],
  );
  // Lựa chọn đã nhớ mà người dùng không còn vai trò ở đó (bị gỡ, chi nhánh ngừng) thì bỏ qua.
  const activeBranchId =
    stored !== null && branchIds.includes(stored) ? stored : (branchIds[0] ?? null);

  const setActiveBranchId = useCallback((branchId: string) => {
    writeStored(branchId);
    setStored(branchId);
  }, []);

  const value = useMemo(
    () => ({ branchIds, activeBranchId, setActiveBranchId }),
    [branchIds, activeBranchId, setActiveBranchId],
  );
  return <ActiveBranchContext.Provider value={value}>{children}</ActiveBranchContext.Provider>;
}
