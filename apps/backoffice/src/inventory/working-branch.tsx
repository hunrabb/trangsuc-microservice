import { Alert, Select, Text } from '@mantine/core';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Outlet } from 'react-router';
import { useBranchLabel, useBranchOptions } from '../api/queries.ts';
import { useActiveBranch } from '../auth/active-branch.tsx';
import { isAdmin } from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';

/**
 * Chi nhánh đang làm việc của các trang kho.
 * - MANAGER, STAFF: chính là "chi nhánh đang làm việc" chọn ở thanh trên (`useActiveBranch`).
 * - ADMIN không thuộc chi nhánh nào nên tự chọn một chi nhánh đang hoạt động; lựa chọn chỉ là id chi nhánh,
 *   nhớ trong localStorage (đọc ghi đều có thể lỗi ở chế độ riêng tư).
 */
const STORAGE_KEY = 'backoffice.inventoryBranchId';

const readStoredChoice = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeStoredChoice = (branchId: string): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, branchId);
  } catch {
    // không nhớ được thì lần sau chọn lại
  }
};

export interface BranchChoice {
  value: string;
  label: string;
}

interface WorkingBranchValue {
  branchId: string | null;
  choices: BranchChoice[];
  chooseBranch(branchId: string): void;
}

const WorkingBranchContext = createContext<WorkingBranchValue | undefined>(undefined);

export function useWorkingBranch(): WorkingBranchValue {
  const value = useContext(WorkingBranchContext);
  if (value === undefined) {
    throw new Error('useWorkingBranch phải nằm trong WorkingBranchLayout');
  }
  return value;
}

/** Layout bọc các trang kho: cung cấp chi nhánh đang làm việc rồi hiện trang con. */
export function WorkingBranchLayout() {
  const { me } = useSession();
  const { branchIds, activeBranchId, setActiveBranchId } = useActiveBranch();
  const branchLabel = useBranchLabel();
  const allBranches = useBranchOptions();
  const [adminChoice, setAdminChoice] = useState<string | null>(readStoredChoice);
  const userIsAdmin = me !== undefined && isAdmin(me.branches);

  const choices = useMemo<BranchChoice[]>(() => {
    if (userIsAdmin) {
      return (allBranches.data?.items ?? [])
        .filter((branch) => branch.isActive)
        .map((branch) => ({ value: branch.id, label: branch.name }));
    }
    return branchIds.map((id) => ({ value: id, label: branchLabel(id) }));
  }, [userIsAdmin, allBranches.data, branchIds, branchLabel]);

  const branchId = userIsAdmin
    ? (choices.find((choice) => choice.value === adminChoice)?.value ?? choices[0]?.value ?? null)
    : activeBranchId;

  const chooseBranch = useCallback(
    (nextBranchId: string) => {
      if (userIsAdmin) {
        writeStoredChoice(nextBranchId);
        setAdminChoice(nextBranchId);
      } else {
        setActiveBranchId(nextBranchId);
      }
    },
    [userIsAdmin, setActiveBranchId],
  );

  const value = useMemo(
    () => ({ branchId, choices, chooseBranch }),
    [branchId, choices, chooseBranch],
  );
  return (
    <WorkingBranchContext.Provider value={value}>
      <Outlet />
    </WorkingBranchContext.Provider>
  );
}

/** Ô chọn chi nhánh ở đầu trang kho. Chỉ có một chi nhánh thì hiện tên, không có thì báo. */
export function BranchSwitcher() {
  const { branchId, choices, chooseBranch } = useWorkingBranch();
  if (choices.length === 0) {
    return (
      <Alert color="yellow" title="Chưa có chi nhánh">
        Tài khoản chưa có vai trò ở chi nhánh nào đang hoạt động.
      </Alert>
    );
  }
  if (choices.length === 1) {
    return (
      <Text size="sm">
        Chi nhánh: <b>{choices[0]?.label}</b>
      </Text>
    );
  }
  return (
    <Select
      label="Chi nhánh"
      w={260}
      allowDeselect={false}
      value={branchId}
      data={choices}
      onChange={(value) => value !== null && chooseBranch(value)}
    />
  );
}
