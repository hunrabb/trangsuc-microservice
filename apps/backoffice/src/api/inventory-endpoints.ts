import type {
  AddReceiptLineRequest,
  Category,
  CreateCategoryRequest,
  CreateMetalPriceRequest,
  CreateMetalRequest,
  CreateProductRequest,
  CreateVariantRequest,
  ItemLabel,
  ItemPage,
  ItemWithPrice,
  Metal,
  MetalPrice,
  MetalPricePage,
  Product,
  ProductPage,
  Receipt,
  ReceiptPage,
  ScanResult,
  StockCountSummary,
  UpdateCategoryRequest,
  UpdateProductRequest,
  UpdateVariantRequest,
  Variant,
  VariantPage,
} from '@jewelry/contracts';
import { isApiError } from './api-error.ts';
import { api } from './instance.ts';

/** Mọi lời gọi tới inventory-service. Đường viết theo đường ở gateway (docs/api/inventory.openapi.yaml). */

const INVENTORY = '/api/admin/inventory';

const queryString = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  return `?${search.toString()}`;
};

export interface ListReceiptsParams {
  page: number;
  pageSize: number;
  branchId: string;
  status?: 'DRAFT' | 'APPROVED';
}

export interface ListItemsParams {
  page: number;
  pageSize: number;
  branchId: string;
  variantId?: string;
  status?: 'IN_STOCK' | 'RESERVED' | 'SOLD';
}

export const inventoryApi = {
  // ------------------------------------------------------------ Kim loại và giá
  listMetals: () => api.request<Metal[]>(`${INVENTORY}/metals`),
  createMetal: (body: CreateMetalRequest) =>
    api.request<Metal>(`${INVENTORY}/metals`, { method: 'POST', body }),
  /** Kim loại chưa có giá thì trả `null` thay vì lỗi, để bảng hiện "Chưa có giá". */
  currentMetalPriceOrNull: async (metalId: string): Promise<MetalPrice | null> => {
    try {
      return await api.request<MetalPrice>(`${INVENTORY}/metals/${metalId}/price`);
    } catch (error) {
      if (isApiError(error) && error.code === 'METAL_PRICE_NOT_SET') {
        return null;
      }
      throw error;
    }
  },
  listMetalPrices: (metalId: string, page: number, pageSize: number) =>
    api.request<MetalPricePage>(
      `${INVENTORY}/metals/${metalId}/prices${queryString({ page, pageSize })}`,
    ),
  createMetalPrice: (metalId: string, body: CreateMetalPriceRequest) =>
    api.request<MetalPrice>(`${INVENTORY}/metals/${metalId}/prices`, { method: 'POST', body }),

  // ------------------------------------------------------------ Danh mục, mẫu, biến thể
  listCategories: () => api.request<Category[]>(`${INVENTORY}/categories`),
  createCategory: (body: CreateCategoryRequest) =>
    api.request<Category>(`${INVENTORY}/categories`, { method: 'POST', body }),
  updateCategory: (id: string, body: UpdateCategoryRequest) =>
    api.request<Category>(`${INVENTORY}/categories/${id}`, { method: 'PATCH', body }),

  listProducts: (page: number, pageSize: number) =>
    api.request<ProductPage>(`${INVENTORY}/products${queryString({ page, pageSize })}`),
  createProduct: (body: CreateProductRequest) =>
    api.request<Product>(`${INVENTORY}/products`, { method: 'POST', body }),
  updateProduct: (id: string, body: UpdateProductRequest) =>
    api.request<Product>(`${INVENTORY}/products/${id}`, { method: 'PATCH', body }),

  listVariants: (page: number, pageSize: number) =>
    api.request<VariantPage>(`${INVENTORY}/variants${queryString({ page, pageSize })}`),
  createVariant: (body: CreateVariantRequest) =>
    api.request<Variant>(`${INVENTORY}/variants`, { method: 'POST', body }),
  updateVariant: (id: string, body: UpdateVariantRequest) =>
    api.request<Variant>(`${INVENTORY}/variants/${id}`, { method: 'PATCH', body }),

  // ------------------------------------------------------------ Phiếu nhập
  listReceipts: (params: ListReceiptsParams) =>
    api.request<ReceiptPage>(`${INVENTORY}/receipts${queryString({ ...params })}`),
  getReceipt: (receiptId: string) => api.request<Receipt>(`${INVENTORY}/receipts/${receiptId}`),
  createReceipt: (branchId: string) =>
    api.request<Receipt>(`${INVENTORY}/receipts`, { method: 'POST', body: { branchId } }),
  addReceiptLine: (receiptId: string, body: AddReceiptLineRequest) =>
    api.request<Receipt>(`${INVENTORY}/receipts/${receiptId}/lines`, { method: 'POST', body }),
  removeReceiptLine: (receiptId: string, lineId: string) =>
    api.request<Receipt>(`${INVENTORY}/receipts/${receiptId}/lines/${lineId}`, {
      method: 'DELETE',
    }),
  approveReceipt: (receiptId: string, version: number) =>
    api.request<Receipt>(`${INVENTORY}/receipts/${receiptId}/approve`, {
      method: 'POST',
      body: { version },
    }),

  // ------------------------------------------------------------ Tồn kho và tem
  listItems: (params: ListItemsParams) =>
    api.request<ItemPage>(`${INVENTORY}/items${queryString({ ...params })}`),
  getItemByTag: (tagCode: string) =>
    api.request<ItemWithPrice>(`${INVENTORY}/items/by-tag/${encodeURIComponent(tagCode)}`),
  getItemLabel: (tagCode: string) =>
    api.request<ItemLabel>(`${INVENTORY}/jewelry-items/${encodeURIComponent(tagCode)}/label`),

  // ------------------------------------------------------------ Kiểm kê
  createStockCount: (branchId: string) =>
    api.request<StockCountSummary>(`${INVENTORY}/stock-counts`, {
      method: 'POST',
      body: { branchId },
    }),
  getStockCount: (stockCountId: string) =>
    api.request<StockCountSummary>(`${INVENTORY}/stock-counts/${stockCountId}`),
  scanStockCount: (stockCountId: string, tagCode: string) =>
    api.request<ScanResult>(`${INVENTORY}/stock-counts/${stockCountId}/scan`, {
      method: 'POST',
      body: { tagCode },
    }),
  closeStockCount: (stockCountId: string) =>
    api.request<StockCountSummary>(`${INVENTORY}/stock-counts/${stockCountId}/close`, {
      method: 'POST',
    }),
};
