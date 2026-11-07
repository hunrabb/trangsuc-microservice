import type {
  Branch,
  BranchPage,
  ChangePasswordRequest,
  CreateBranchRequest,
  CreateUserRequest,
  CurrentUser,
  ReplaceAssignmentsRequest,
  ResetPasswordRequest,
  UpdateBranchRequest,
  UpdateUserRequest,
  User,
  UserPage,
} from '@jewelry/contracts';
import { api } from './instance.ts';

/** Mọi lời gọi tới auth-service. Đường viết theo đường ở gateway (docs/api/auth.openapi.yaml). */

const ADMIN = '/api/admin/auth';

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  return `?${search.toString()}`;
};

export const authApi = {
  me: () => api.request<CurrentUser>('/api/auth/me'),
  changePassword: (body: ChangePasswordRequest) =>
    api.request<void>('/api/auth/change-password', { method: 'POST', body }),
  logoutAll: () => api.request<void>('/api/auth/logout-all', { method: 'POST' }),

  listBranches: (page: number, pageSize: number) =>
    api.request<BranchPage>(`${ADMIN}/branches${query({ page, pageSize })}`),
  createBranch: (body: CreateBranchRequest) =>
    api.request<Branch>(`${ADMIN}/branches`, { method: 'POST', body }),
  updateBranch: (id: string, body: UpdateBranchRequest) =>
    api.request<Branch>(`${ADMIN}/branches/${id}`, { method: 'PATCH', body }),
  deactivateBranch: (id: string) =>
    api.request<Branch>(`${ADMIN}/branches/${id}/deactivate`, { method: 'POST' }),
  activateBranch: (id: string) =>
    api.request<Branch>(`${ADMIN}/branches/${id}/activate`, { method: 'POST' }),

  listUsers: (params: { page: number; pageSize: number; branchId?: string }) =>
    api.request<UserPage>(`${ADMIN}/users${query(params)}`),
  createUser: (body: CreateUserRequest) =>
    api.request<User>(`${ADMIN}/users`, { method: 'POST', body }),
  updateUser: (id: string, body: UpdateUserRequest) =>
    api.request<User>(`${ADMIN}/users/${id}`, { method: 'PATCH', body }),
  lockUser: (id: string) => api.request<User>(`${ADMIN}/users/${id}/lock`, { method: 'POST' }),
  unlockUser: (id: string) => api.request<User>(`${ADMIN}/users/${id}/unlock`, { method: 'POST' }),
  unlinkGoogle: (id: string) =>
    api.request<User>(`${ADMIN}/users/${id}/unlink-google`, { method: 'POST' }),
  resetPassword: (id: string, body: ResetPasswordRequest) =>
    api.request<void>(`${ADMIN}/users/${id}/reset-password`, { method: 'POST', body }),
  replaceAssignments: (id: string, body: ReplaceAssignmentsRequest) =>
    api.request<User>(`${ADMIN}/users/${id}/assignments`, { method: 'PUT', body }),
};
