import { violatedUniqueIndex } from '@jewelry/common';
import type {
  Category,
  CreateCategoryRequest,
  CreateProductRequest,
  CreateVariantRequest,
  ListProductsQuery,
  ListVariantsQuery,
  Product,
  ProductPage,
  UpdateCategoryRequest,
  UpdateProductRequest,
  UpdateVariantRequest,
  Variant,
  VariantPage,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fieldError, notFound, pageArgs, versionConflict } from '../common/errors';

const toCategory = ({
  id,
  name,
  isActive,
  version,
}: Prisma.CategoryGetPayload<object>): Category => ({
  id,
  name,
  isActive,
  version,
});

const toProduct = ({
  publishedOnline,
  imageUrl,
  id,
  categoryId,
  name,
  description,
  isActive,
  version,
}: Prisma.ProductGetPayload<object>): Product => ({
  publishedOnline,
  imageUrl,
  id,
  categoryId,
  name,
  description,
  isActive,
  version,
});

const toVariant = (row: Prisma.ProductVariantGetPayload<object>): Variant => ({
  id: row.id,
  productId: row.productId,
  metalId: row.metalId,
  sku: row.sku,
  name: row.name,
  defaultLaborFee: row.defaultLaborFee.toFixed(2),
  isActive: row.isActive,
  version: row.version,
});

/**
 * Danh mục, mẫu, biến thể: CRUD cơ bản, chỉ ADMIN ghi. Không có xoá: muốn ngừng dùng thì đặt `isActive = false`,
 * vì hàng đã nhập vẫn tham chiếu tới biến thể.
 * Mọi thao tác sửa dùng khoá lạc quan: `updateMany({ where: { id, version } })`, 0 dòng thì phân biệt
 * "không có" (`404`) với "người khác vừa sửa" (`409 VERSION_CONFLICT`).
 */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------ Danh mục
  async listCategories(): Promise<Category[]> {
    return (await this.prisma.category.findMany({ orderBy: { name: 'asc' } })).map(toCategory);
  }

  async createCategory(body: CreateCategoryRequest): Promise<Category> {
    try {
      return toCategory(await this.prisma.category.create({ data: body }));
    } catch (error) {
      if (violatedUniqueIndex(error) === 'Category_name_key') {
        throw fieldError({ field: 'name', message: 'Tên danh mục đã tồn tại' });
      }
      throw error;
    }
  }

  async updateCategory(
    id: string,
    { version, ...changes }: UpdateCategoryRequest,
  ): Promise<Category> {
    try {
      const { count } = await this.prisma.category.updateMany({
        where: { id, version },
        data: { ...changes, version: { increment: 1 } },
      });
      if (count === 0) {
        throw (await this.prisma.category.count({ where: { id } })) === 0
          ? notFound('danh mục')
          : versionConflict();
      }
    } catch (error) {
      if (violatedUniqueIndex(error) === 'Category_name_key') {
        throw fieldError({ field: 'name', message: 'Tên danh mục đã tồn tại' });
      }
      throw error;
    }
    return toCategory(await this.prisma.category.findUniqueOrThrow({ where: { id } }));
  }

  // ------------------------------------------------------------ Mẫu
  async listProducts({ categoryId, ...paging }: ListProductsQuery): Promise<ProductPage> {
    const where = categoryId === undefined ? {} : { categoryId };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, orderBy: { name: 'asc' }, ...pageArgs(paging) }),
      this.prisma.product.count({ where }),
    ]);
    return { items: rows.map(toProduct), total, ...paging };
  }

  async createProduct(body: CreateProductRequest): Promise<Product> {
    await this.requireCategory(body.categoryId);
    return toProduct(await this.prisma.product.create({ data: body }));
  }

  async updateProduct(id: string, { version, ...changes }: UpdateProductRequest): Promise<Product> {
    if (changes.categoryId !== undefined) {
      await this.requireCategory(changes.categoryId);
    }
    const { count } = await this.prisma.product.updateMany({
      where: { id, version },
      data: { ...changes, version: { increment: 1 } },
    });
    if (count === 0) {
      throw (await this.prisma.product.count({ where: { id } })) === 0
        ? notFound('mẫu')
        : versionConflict();
    }
    return toProduct(await this.prisma.product.findUniqueOrThrow({ where: { id } }));
  }

  // ------------------------------------------------------------ Biến thể
  async listVariants({ productId, ...paging }: ListVariantsQuery): Promise<VariantPage> {
    const where = productId === undefined ? {} : { productId };
    const [rows, total] = await Promise.all([
      this.prisma.productVariant.findMany({ where, orderBy: { sku: 'asc' }, ...pageArgs(paging) }),
      this.prisma.productVariant.count({ where }),
    ]);
    return { items: rows.map(toVariant), total, ...paging };
  }

  /** Đồng thời: hai request cùng `sku` thì unique chặn một bên (`ProductVariant_sku_key`). */
  async createVariant(body: CreateVariantRequest): Promise<Variant> {
    const [product, metal] = await Promise.all([
      this.prisma.product.count({ where: { id: body.productId } }),
      this.prisma.metal.count({ where: { id: body.metalId } }),
    ]);
    if (product === 0) {
      throw fieldError({ field: 'productId', message: 'Mẫu không tồn tại' });
    }
    if (metal === 0) {
      throw fieldError({ field: 'metalId', message: 'Kim loại không tồn tại' });
    }
    try {
      return toVariant(await this.prisma.productVariant.create({ data: body }));
    } catch (error) {
      if (violatedUniqueIndex(error) === 'ProductVariant_sku_key') {
        throw fieldError({ field: 'sku', message: 'Mã SKU đã tồn tại' });
      }
      throw error;
    }
  }

  async updateVariant(id: string, { version, ...changes }: UpdateVariantRequest): Promise<Variant> {
    const { count } = await this.prisma.productVariant.updateMany({
      where: { id, version },
      data: { ...changes, version: { increment: 1 } },
    });
    if (count === 0) {
      throw (await this.prisma.productVariant.count({ where: { id } })) === 0
        ? notFound('biến thể')
        : versionConflict();
    }
    return toVariant(await this.prisma.productVariant.findUniqueOrThrow({ where: { id } }));
  }

  private async requireCategory(id: string): Promise<void> {
    if ((await this.prisma.category.count({ where: { id } })) === 0) {
      throw fieldError({ field: 'categoryId', message: 'Danh mục không tồn tại' });
    }
  }
}
