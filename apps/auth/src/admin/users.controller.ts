import { type AuthUser, CurrentUser, ZodValidationPipe } from '@jewelry/common';
import {
  type CreateUserRequest,
  createUserRequestSchema,
  type ListUsersQuery,
  listUsersQuerySchema,
  type ReplaceAssignmentsRequest,
  replaceAssignmentsRequestSchema,
  type ResetPasswordRequest,
  resetPasswordRequestSchema,
  type UpdateUserRequest,
  updateUserRequestSchema,
  type User,
  type UserPage,
} from '@jewelry/contracts';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { UsersService } from './users.service';
import { UUID_PARAM } from './uuid-param';

/** Cửa vào HTTP. Quyền kiểm ở `policy.ts`, gọi từ service. */
@Controller('admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listUsersQuerySchema)) query: ListUsersQuery,
  ): Promise<UserPage> {
    return this.users.list(user.id, query);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createUserRequestSchema)) body: CreateUserRequest,
  ): Promise<User> {
    return this.users.create(user.id, body);
  }

  @Get(':userId')
  get(@CurrentUser() user: AuthUser, @Param('userId', UUID_PARAM) userId: string): Promise<User> {
    return this.users.get(user.id, userId);
  }

  @Patch(':userId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('userId', UUID_PARAM) userId: string,
    @Body(new ZodValidationPipe(updateUserRequestSchema)) body: UpdateUserRequest,
  ): Promise<User> {
    return this.users.update(user.id, userId, body);
  }

  @Post(':userId/lock')
  @HttpCode(200)
  lock(@CurrentUser() user: AuthUser, @Param('userId', UUID_PARAM) userId: string): Promise<User> {
    return this.users.lock(user.id, userId);
  }

  @Post(':userId/unlock')
  @HttpCode(200)
  unlock(
    @CurrentUser() user: AuthUser,
    @Param('userId', UUID_PARAM) userId: string,
  ): Promise<User> {
    return this.users.unlock(user.id, userId);
  }

  @Post(':userId/unlink-google')
  @HttpCode(200)
  unlinkGoogle(
    @CurrentUser() user: AuthUser,
    @Param('userId', UUID_PARAM) userId: string,
  ): Promise<User> {
    return this.users.unlinkGoogle(user.id, userId);
  }

  @Post(':userId/reset-password')
  @HttpCode(204)
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('userId', UUID_PARAM) userId: string,
    @Body(new ZodValidationPipe(resetPasswordRequestSchema)) body: ResetPasswordRequest,
  ): Promise<void> {
    return this.users.resetPassword(user.id, userId, body);
  }

  @Put(':userId/assignments')
  replaceAssignments(
    @CurrentUser() user: AuthUser,
    @Param('userId', UUID_PARAM) userId: string,
    @Body(new ZodValidationPipe(replaceAssignmentsRequestSchema)) body: ReplaceAssignmentsRequest,
  ): Promise<User> {
    return this.users.replaceAssignments(user.id, userId, body);
  }
}
