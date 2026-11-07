import { z } from 'zod';
import { branchRoleSchema, roleSchema } from './auth';
import {
  authSessionSchema,
  authUserSchema,
  branchPageSchema,
  branchSchema,
  changePasswordRequestSchema,
  createBranchRequestSchema,
  createUserRequestSchema,
  currentUserSchema,
  googleLoginRequestSchema,
  passwordLoginRequestSchema,
  replaceAssignmentsRequestSchema,
  resetPasswordRequestSchema,
  updateBranchRequestSchema,
  updateUserRequestSchema,
  userPageSchema,
  userSchema,
} from './auth-api';
import { errorResponseSchema } from './error-response';

/** Tên trong `components/schemas` của docs/api/auth.openapi.yaml → schema zod. */
const AUTH_OPENAPI_SCHEMAS = {
  ErrorResponse: errorResponseSchema,
  Role: roleSchema,
  Assignment: branchRoleSchema,
  AuthUser: authUserSchema,
  CurrentUser: currentUserSchema,
  AuthSession: authSessionSchema,
  GoogleLoginRequest: googleLoginRequestSchema,
  PasswordLoginRequest: passwordLoginRequestSchema,
  ChangePasswordRequest: changePasswordRequestSchema,
  ResetPasswordRequest: resetPasswordRequestSchema,
  Branch: branchSchema,
  BranchPage: branchPageSchema,
  CreateBranchRequest: createBranchRequestSchema,
  UpdateBranchRequest: updateBranchRequestSchema,
  User: userSchema,
  UserPage: userPageSchema,
  CreateUserRequest: createUserRequestSchema,
  UpdateUserRequest: updateUserRequestSchema,
  ReplaceAssignmentsRequest: replaceAssignmentsRequestSchema,
};

/** Sinh `components/schemas` từ zod. Script `pnpm openapi:generate` ghi kết quả vào file YAML. */
export function authOpenApiSchemas(): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(AUTH_OPENAPI_SCHEMAS)) {
    registry.add(schema, { id });
  }
  const { schemas } = z.toJSONSchema(registry, { uri: (id) => `#/components/schemas/${id}` });
  return Object.fromEntries(
    Object.entries(schemas).map(([id, schema]) => {
      const cleaned = { ...schema };
      delete cleaned.$schema;
      delete cleaned.$id;
      return [id, cleaned];
    }),
  );
}
