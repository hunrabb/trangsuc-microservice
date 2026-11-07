import { type AuthUser, CurrentUser, ZodValidationPipe } from '@jewelry/common';
import {
  type Branch,
  type BranchPage,
  type CreateBranchRequest,
  createBranchRequestSchema,
  type PaginationQuery,
  paginationQuerySchema,
  type UpdateBranchRequest,
  updateBranchRequestSchema,
} from '@jewelry/contracts';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { UUID_PARAM } from './uuid-param';

/** Cửa vào HTTP. Quyền kiểm ở `policy.ts`, gọi từ service. */
@Controller('admin/branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<BranchPage> {
    return this.branches.list(user.id, query);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createBranchRequestSchema)) body: CreateBranchRequest,
  ): Promise<Branch> {
    return this.branches.create(user.id, body);
  }

  @Patch(':branchId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('branchId', UUID_PARAM) branchId: string,
    @Body(new ZodValidationPipe(updateBranchRequestSchema)) body: UpdateBranchRequest,
  ): Promise<Branch> {
    return this.branches.update(user.id, branchId, body);
  }

  @Post(':branchId/deactivate')
  @HttpCode(200)
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('branchId', UUID_PARAM) branchId: string,
  ): Promise<Branch> {
    return this.branches.deactivate(user.id, branchId);
  }

  @Post(':branchId/activate')
  @HttpCode(200)
  activate(
    @CurrentUser() user: AuthUser,
    @Param('branchId', UUID_PARAM) branchId: string,
  ): Promise<Branch> {
    return this.branches.activate(user.id, branchId);
  }
}
