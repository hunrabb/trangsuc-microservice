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
  currentUserAssignmentSchema,
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
import {
  addReceiptLineRequestSchema,
  createStockCountRequestSchema,
  itemLabelSchema,
  scanResultSchema,
  scanStockCountRequestSchema,
  stockCountSummarySchema,
  approveReceiptRequestSchema,
  categorySchema,
  createCategoryRequestSchema,
  createMetalPriceRequestSchema,
  createMetalRequestSchema,
  createProductRequestSchema,
  createReceiptRequestSchema,
  createVariantRequestSchema,
  itemPageSchema,
  itemSchema,
  itemWithPriceSchema,
  metalPricePageSchema,
  metalPriceSchema,
  metalSchema,
  productPageSchema,
  productSchema,
  receiptPageSchema,
  receiptSchema,
  updateCategoryRequestSchema,
  updateProductRequestSchema,
  updateVariantRequestSchema,
  variantPageSchema,
  variantSchema,
} from './inventory-api';

/** Tên trong `components/schemas` của docs/api/auth.openapi.yaml → schema zod. */
const AUTH_OPENAPI_SCHEMAS = {
  ErrorResponse: errorResponseSchema,
  Role: roleSchema,
  Assignment: branchRoleSchema,
  AuthUser: authUserSchema,
  CurrentUserAssignment: currentUserAssignmentSchema,
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
function toOpenApiSchemas(definitions: Record<string, z.ZodType>): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(definitions)) {
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

export const authOpenApiSchemas = (): Record<string, unknown> =>
  toOpenApiSchemas(AUTH_OPENAPI_SCHEMAS);

/** Tên trong `components/schemas` của docs/api/inventory.openapi.yaml → schema zod. */
const INVENTORY_OPENAPI_SCHEMAS = {
  ErrorResponse: errorResponseSchema,
  Metal: metalSchema,
  CreateMetalRequest: createMetalRequestSchema,
  MetalPrice: metalPriceSchema,
  MetalPricePage: metalPricePageSchema,
  CreateMetalPriceRequest: createMetalPriceRequestSchema,
  Category: categorySchema,
  CreateCategoryRequest: createCategoryRequestSchema,
  UpdateCategoryRequest: updateCategoryRequestSchema,
  Product: productSchema,
  ProductPage: productPageSchema,
  CreateProductRequest: createProductRequestSchema,
  UpdateProductRequest: updateProductRequestSchema,
  Variant: variantSchema,
  VariantPage: variantPageSchema,
  CreateVariantRequest: createVariantRequestSchema,
  UpdateVariantRequest: updateVariantRequestSchema,
  Receipt: receiptSchema,
  ReceiptPage: receiptPageSchema,
  CreateReceiptRequest: createReceiptRequestSchema,
  AddReceiptLineRequest: addReceiptLineRequestSchema,
  ApproveReceiptRequest: approveReceiptRequestSchema,
  Item: itemSchema,
  ItemPage: itemPageSchema,
  ItemWithPrice: itemWithPriceSchema,
  CreateStockCountRequest: createStockCountRequestSchema,
  ScanStockCountRequest: scanStockCountRequestSchema,
  ScanResult: scanResultSchema,
  StockCountSummary: stockCountSummarySchema,
  ItemLabel: itemLabelSchema,
};

export const inventoryOpenApiSchemas = (): Record<string, unknown> =>
  toOpenApiSchemas(INVENTORY_OPENAPI_SCHEMAS);
