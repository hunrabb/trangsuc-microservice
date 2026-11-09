import {
  buybackStatusSchema,
  createBuybackSchema,
  updateBuybackSchema,
  submitBuybackSchema,
  cancelBuybackSchema,
  buybackDetailSchema,
  buybackPageSchema,
  buybackQuerySchema,
} from './buyback-api';
import {
  onlinePaymentAdminViewSchema,
  confirmOnlinePaymentSchema,
  requestOnlineRefundSchema,
  onlinePaymentViewSchema,
  onlineOrderPaidSchema,
  paymentInventoryResultSchema,
} from './online-payment';
import {
  createOnlineOrderSchema,
  onlineOrderViewSchema,
  onlineCartSchema,
  onlineOrderCreatedSchema,
  stockReservedSchema,
  stockReserveFailedSchema,
  stockReservationExpiredSchema,
} from './online-checkout';
import {
  shopProductSchema,
  shopPageSchema,
  onlineWarehouseSchema,
  onlineBufferSchema,
} from './shop-api';
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
  createPosCustomerRequestSchema,
  createPosOrderRequestSchema,
  posCustomerOrdersSchema,
  posCustomerSchema,
  posOrderItemSchema,
  posOrderSchema,
  posOrderStatusSchema,
} from './sales-api';
import {
  quoteStockRequestSchema,
  quoteStockResponseSchema,
  deductStockRequestSchema,
  deductStockResponseSchema,
  releaseStockRequestSchema,
  releaseStockResponseSchema,
  stockOrderStateResponseSchema,
} from './inventory-internal-api';
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
  OnlineOrderPaid: onlineOrderPaidSchema,
  PaymentInventoryResult: paymentInventoryResultSchema,
  OnlineOrderCreated: onlineOrderCreatedSchema,
  StockReserved: stockReservedSchema,
  StockReserveFailed: stockReserveFailedSchema,
  StockReservationExpired: stockReservationExpiredSchema,
  OnlineWarehouse: onlineWarehouseSchema,
  OnlineBuffer: onlineBufferSchema,
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
  QuoteStockRequest: quoteStockRequestSchema,
  QuoteStockResponse: quoteStockResponseSchema,
  DeductStockRequest: deductStockRequestSchema,
  DeductStockResponse: deductStockResponseSchema,
  ReleaseStockRequest: releaseStockRequestSchema,
  ReleaseStockResponse: releaseStockResponseSchema,
  StockOrderStateResponse: stockOrderStateResponseSchema,
};

export const inventoryOpenApiSchemas = (): Record<string, unknown> =>
  toOpenApiSchemas(INVENTORY_OPENAPI_SCHEMAS);

/** Hợp đồng POS cùng một nguồn zod cho sales, client và OpenAPI. */
export const salesOpenApiSchemas = (): Record<string, unknown> =>
  toOpenApiSchemas({
    BuybackStatus: buybackStatusSchema,
    CreateBuyback: createBuybackSchema,
    UpdateBuyback: updateBuybackSchema,
    SubmitBuyback: submitBuybackSchema,
    CancelBuyback: cancelBuybackSchema,
    BuybackDetail: buybackDetailSchema,
    BuybackPage: buybackPageSchema,
    BuybackQuery: buybackQuerySchema,
    ErrorResponse: errorResponseSchema,
    ConfirmOnlinePayment: confirmOnlinePaymentSchema,
    RequestOnlineRefund: requestOnlineRefundSchema,
    OnlinePayment: onlinePaymentViewSchema,
    OnlinePaymentAdmin: onlinePaymentAdminViewSchema,
    CreatePosOrderRequest: createPosOrderRequestSchema,
    CreatePosCustomerRequest: createPosCustomerRequestSchema,
    PosCustomer: posCustomerSchema,
    PosCustomerOrders: posCustomerOrdersSchema,
    PosOrderStatus: posOrderStatusSchema,
    PosOrderItem: posOrderItemSchema,
    PosOrder: posOrderSchema,
  });

export const shopOpenApiSchemas = (): Record<string, unknown> =>
  toOpenApiSchemas({
    CreateOnlineOrder: createOnlineOrderSchema,
    OnlineOrderView: onlineOrderViewSchema,
    OnlineCart: onlineCartSchema,
    ShopProduct: shopProductSchema,
    ShopPage: shopPageSchema,
    ErrorResponse: errorResponseSchema,
  });
