import { z } from 'zod';
import { branchRoleSchema } from './auth';

/**
 * Schema body/response của auth API, dùng chung cho auth và backoffice. Đặc tả: docs/api/auth.openapi.yaml.
 * File này chạy được cả trên trình duyệt: không dùng API riêng của Node.
 */

export const PASSWORD_MIN_LENGTH = 12;
/** bcrypt bỏ qua phần sau 72 byte: mật khẩu dài hơn sẽ không được bảo vệ hết. */
export const PASSWORD_MAX_BYTES = 72;

/**
 * Luật mật khẩu mới. Trả về `true` nếu đạt; không đạt thì auth trả `400 PASSWORD_TOO_WEAK`.
 * Không đặt vào schema body để lỗi có đúng mã riêng, và để body đăng nhập không lộ luật này.
 */
export function isAcceptablePassword(password: string): boolean {
  return (
    password.length >= PASSWORD_MIN_LENGTH &&
    new TextEncoder().encode(password).length <= PASSWORD_MAX_BYTES
  );
}

const email = z.email();
const nonEmpty = z.string().min(1);
const version = z.number().int().positive();

/** Bản ghi có vai trò ADMIN thì phải có mật khẩu, và ngược lại. */
const hasAdminRole = (assignments: readonly { role: string }[]): boolean =>
  assignments.some((assignment) => assignment.role === 'ADMIN');

/** Mỗi chi nhánh một vai trò: `UserBranch` unique theo (userId, branchId). */
export const assignmentsSchema = z
  .array(branchRoleSchema)
  .min(1)
  .refine(
    (assignments) =>
      new Set(assignments.map((assignment) => assignment.branchId)).size === assignments.length,
    { error: 'Mỗi chi nhánh chỉ có một vai trò' },
  );

// ---------------------------------------------------------------- Phân trang
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

/** Query string luôn là chuỗi nên phải `coerce`. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

const pageOf = <Item extends z.ZodType>(item: Item) =>
  z.object({
    items: z.array(item),
    total: z.number().int().nonnegative().describe('Tổng số dòng khớp, không chỉ trang này'),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  });

// ---------------------------------------------------------------- Xác thực
export const googleLoginRequestSchema = z.strictObject({
  credential: nonEmpty.describe('ID token từ Google Identity Services'),
});

export const passwordLoginRequestSchema = z.strictObject({ email, password: nonEmpty });

const newPassword = nonEmpty.describe(
  `Tối thiểu ${PASSWORD_MIN_LENGTH} ký tự, tối đa ${PASSWORD_MAX_BYTES} byte UTF-8. Sai → PASSWORD_TOO_WEAK.`,
);

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: nonEmpty,
  newPassword,
});

export const resetPasswordRequestSchema = z.strictObject({ newPassword });

export const authUserSchema = z.object({
  id: z.uuid(),
  email,
  fullName: z.string(),
  branches: z.array(branchRoleSchema),
});

export const currentUserSchema = authUserSchema.extend({ googleLinked: z.boolean() });

export const authSessionSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive().describe('Số giây, 900'),
  user: authUserSchema,
});

// ---------------------------------------------------------------- Chi nhánh
export const branchSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  isActive: z.boolean(),
  version,
});

export const branchPageSchema = pageOf(branchSchema);

export const createBranchRequestSchema = z.strictObject({
  code: nonEmpty,
  name: nonEmpty,
  address: z.string().optional(),
  phone: z.string().optional(),
});

export const updateBranchRequestSchema = z.strictObject({
  version,
  name: nonEmpty.optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
});

// ---------------------------------------------------------------- Nhân viên
export const userStatusSchema = z.enum(['ACTIVE', 'LOCKED']);

export const userSchema = z.object({
  id: z.uuid(),
  email,
  fullName: z.string(),
  phone: z.string().nullable(),
  status: userStatusSchema,
  googleLinked: z.boolean(),
  branches: z.array(branchRoleSchema),
  version,
});

export const userPageSchema = pageOf(userSchema);

export const listUsersQuerySchema = paginationQuerySchema.extend({
  branchId: z.uuid().optional(),
});

/** `password` bắt buộc khi và chỉ khi có vai trò ADMIN. */
export const createUserRequestSchema = z
  .strictObject({
    email,
    fullName: nonEmpty,
    phone: z.string().optional(),
    assignments: assignmentsSchema,
    password: newPassword.optional().describe('Bắt buộc khi và chỉ khi có vai trò ADMIN'),
  })
  .refine((body) => hasAdminRole(body.assignments) === (body.password !== undefined), {
    path: ['password'],
    error: 'password bắt buộc khi và chỉ khi có vai trò ADMIN',
  });

export const updateUserRequestSchema = z.strictObject({
  version,
  fullName: nonEmpty.optional(),
  phone: z.string().nullable().optional(),
});

/**
 * Thêm vai trò ADMIN thì phải kèm `password`. Việc "thêm" chỉ auth biết được (so với vai trò hiện tại),
 * nên schema chỉ kiểm dạng; `password` không có vai trò ADMIN thì vô nghĩa nên bị từ chối ngay ở đây.
 */
export const replaceAssignmentsRequestSchema = z
  .strictObject({
    assignments: assignmentsSchema,
    password: newPassword.optional().describe('Bắt buộc khi thêm vai trò ADMIN'),
  })
  .refine((body) => body.password === undefined || hasAdminRole(body.assignments), {
    path: ['password'],
    error: 'password chỉ dùng khi có vai trò ADMIN',
  });

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type BranchPage = z.infer<typeof branchPageSchema>;
export type UserPage = z.infer<typeof userPageSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type GoogleLoginRequest = z.infer<typeof googleLoginRequestSchema>;
export type PasswordLoginRequest = z.infer<typeof passwordLoginRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type Branch = z.infer<typeof branchSchema>;
export type CreateBranchRequest = z.infer<typeof createBranchRequestSchema>;
export type UpdateBranchRequest = z.infer<typeof updateBranchRequestSchema>;
export type User = z.infer<typeof userSchema>;
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
export type ReplaceAssignmentsRequest = z.infer<typeof replaceAssignmentsRequestSchema>;
