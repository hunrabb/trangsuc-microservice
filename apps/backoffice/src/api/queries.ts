import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { isAdmin } from '../auth/permissions.ts';
import { authApi } from './endpoints.ts';
import { useSession } from '../auth/session-context.tsx';

/** Số dòng lớn nhất server cho mỗi trang. */
export const MAX_PAGE_SIZE = 100;

export const queryKeys = {
  me: ['me'] as const,
  branches: ['branches'] as const,
  branchOptions: ['branches', 'options'] as const,
  users: ['users'] as const,
};

/** Một trang chi nhánh (bảng quản lý). Giữ trang cũ trong lúc tải trang mới để bảng không nhấp nháy. */
export const useBranchPage = (page: number, pageSize: number) =>
  useQuery({
    queryKey: [...queryKeys.branches, 'page', page, pageSize],
    queryFn: () => authApi.listBranches(page, pageSize),
    placeholderData: keepPreviousData,
  });

/**
 * Toàn bộ chi nhánh (tối đa một trang lớn nhất) để lấy tên và để chọn. Chỉ ADMIN gọi được: các vai trò
 * khác không có quyền xem danh sách chi nhánh nên không có tên, xem `useBranchLabel`.
 */
export function useBranchOptions() {
  const { me } = useSession();
  return useQuery({
    queryKey: queryKeys.branchOptions,
    queryFn: () => authApi.listBranches(1, MAX_PAGE_SIZE),
    enabled: me !== undefined && isAdmin(me.branches),
  });
}

/** Tên chi nhánh theo id. Không biết tên (không phải ADMIN) thì hiện mã rút gọn của id. */
export function useBranchLabel(): (branchId: string | null) => string {
  const options = useBranchOptions();
  const items = options.data?.items;
  return useCallback(
    (branchId) => {
      if (branchId === null) {
        return 'Toàn hệ thống';
      }
      const found = items?.find((branch) => branch.id === branchId);
      return found === undefined ? `Chi nhánh …${branchId.slice(0, 8)}` : found.name;
    },
    [items],
  );
}
