import { z } from 'zod';

export const ROLES = ['ADMIN', 'MANAGER', 'STAFF'] as const;

export const roleSchema = z.enum(ROLES);

export type Role = z.infer<typeof roleSchema>;

/** ADMIN áp dụng toàn hệ thống nên `branchId = null`; MANAGER, STAFF luôn gắn với một chi nhánh. */
export const branchRoleSchema = z
  .object({ branchId: z.uuid().nullable(), role: roleSchema })
  .refine((value) => (value.role === 'ADMIN') === (value.branchId === null), {
    error: 'ADMIN có branchId = null, vai trò khác phải có branchId',
  });

export type BranchRole = z.infer<typeof branchRoleSchema>;

/** Phần nghiệp vụ trong access token. `iss`, `aud`, `exp`... do bước kiểm tra token xử lý. */
export const accessTokenClaimsSchema = z.object({
  sub: z.uuid(),
  branches: z.array(branchRoleSchema),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;
