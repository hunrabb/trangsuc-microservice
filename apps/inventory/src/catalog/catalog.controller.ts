import { Roles, ZodValidationPipe } from '@jewelry/common';
import {
  type Category,
  type CreateCategoryRequest,
  createCategoryRequestSchema,
  type CreateProductRequest,
  createProductRequestSchema,
  type CreateVariantRequest,
  createVariantRequestSchema,
  type ListProductsQuery,
  listProductsQuerySchema,
  type ListVariantsQuery,
  listVariantsQuerySchema,
  type Product,
  type ProductPage,
  type UpdateCategoryRequest,
  updateCategoryRequestSchema,
  type UpdateProductRequest,
  updateProductRequestSchema,
  type UpdateVariantRequest,
  updateVariantRequestSchema,
  type Variant,
  type VariantPage,
} from '@jewelry/contracts';
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { UUID_PARAM } from '../common/uuid-param';
import { CatalogService } from './catalog.service';

/** Cửa vào HTTP của danh mục, mẫu, biến thể. Xem tự do cho mọi nhân viên; ghi chỉ ADMIN. */
@Controller('admin')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  listCategories(): Promise<Category[]> {
    return this.catalog.listCategories();
  }

  @Roles('ADMIN')
  @Post('categories')
  createCategory(
    @Body(new ZodValidationPipe(createCategoryRequestSchema)) body: CreateCategoryRequest,
  ): Promise<Category> {
    return this.catalog.createCategory(body);
  }

  @Roles('ADMIN')
  @Patch('categories/:categoryId')
  updateCategory(
    @Param('categoryId', UUID_PARAM) id: string,
    @Body(new ZodValidationPipe(updateCategoryRequestSchema)) body: UpdateCategoryRequest,
  ): Promise<Category> {
    return this.catalog.updateCategory(id, body);
  }

  @Get('products')
  listProducts(
    @Query(new ZodValidationPipe(listProductsQuerySchema)) query: ListProductsQuery,
  ): Promise<ProductPage> {
    return this.catalog.listProducts(query);
  }

  @Roles('ADMIN')
  @Post('products')
  createProduct(
    @Body(new ZodValidationPipe(createProductRequestSchema)) body: CreateProductRequest,
  ): Promise<Product> {
    return this.catalog.createProduct(body);
  }

  @Roles('ADMIN')
  @Patch('products/:productId')
  updateProduct(
    @Param('productId', UUID_PARAM) id: string,
    @Body(new ZodValidationPipe(updateProductRequestSchema)) body: UpdateProductRequest,
  ): Promise<Product> {
    return this.catalog.updateProduct(id, body);
  }

  @Get('variants')
  listVariants(
    @Query(new ZodValidationPipe(listVariantsQuerySchema)) query: ListVariantsQuery,
  ): Promise<VariantPage> {
    return this.catalog.listVariants(query);
  }

  @Roles('ADMIN')
  @Post('variants')
  createVariant(
    @Body(new ZodValidationPipe(createVariantRequestSchema)) body: CreateVariantRequest,
  ): Promise<Variant> {
    return this.catalog.createVariant(body);
  }

  @Roles('ADMIN')
  @Patch('variants/:variantId')
  updateVariant(
    @Param('variantId', UUID_PARAM) id: string,
    @Body(new ZodValidationPipe(updateVariantRequestSchema)) body: UpdateVariantRequest,
  ): Promise<Variant> {
    return this.catalog.updateVariant(id, body);
  }
}
