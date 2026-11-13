import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { inventoryApi } from './inventory-endpoints.ts';

/** Số dòng lớn nhất server cho mỗi trang: dùng khi cần cả danh sách để chọn (biến thể, mẫu, kim loại). */
const LOOKUP_PAGE_SIZE = 100;

export const inventoryKeys = {
  metals: ['inventory', 'metals'] as const,
  metalPrice: (metalId: string) => ['inventory', 'metals', metalId, 'price'] as const,
  metalPrices: (metalId: string, page: number) =>
    ['inventory', 'metals', metalId, 'prices', page] as const,
  categories: ['inventory', 'categories'] as const,
  products: ['inventory', 'products'] as const,
  variants: ['inventory', 'variants'] as const,
  receipts: ['inventory', 'receipts'] as const,
  items: ['inventory', 'items'] as const,
};

export const useMetals = () =>
  useQuery({ queryKey: inventoryKeys.metals, queryFn: inventoryApi.listMetals });

export const useCategories = () =>
  useQuery({ queryKey: inventoryKeys.categories, queryFn: inventoryApi.listCategories });

/** Toàn bộ mẫu (một trang lớn nhất) để chọn trong biểu mẫu và hiện tên. */
export const useAllProducts = () =>
  useQuery({
    queryKey: [...inventoryKeys.products, 'all'],
    queryFn: () => inventoryApi.listProducts(1, LOOKUP_PAGE_SIZE),
  });

/** Toàn bộ biến thể (một trang lớn nhất) để chọn trong phiếu nhập, bộ lọc tồn kho và hiện tên. */
export const useAllVariants = () =>
  useQuery({
    queryKey: [...inventoryKeys.variants, 'all'],
    queryFn: () => inventoryApi.listVariants(1, LOOKUP_PAGE_SIZE),
  });

export const useProductPage = (page: number, pageSize: number) =>
  useQuery({
    queryKey: [...inventoryKeys.products, 'page', page, pageSize],
    queryFn: () => inventoryApi.listProducts(page, pageSize),
    placeholderData: keepPreviousData,
  });

export const useVariantPage = (page: number, pageSize: number) =>
  useQuery({
    queryKey: [...inventoryKeys.variants, 'page', page, pageSize],
    queryFn: () => inventoryApi.listVariants(page, pageSize),
    placeholderData: keepPreviousData,
  });
