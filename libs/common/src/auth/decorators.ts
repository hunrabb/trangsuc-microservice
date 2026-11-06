import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role, TokenAudience } from '@jewelry/contracts';
import type { AuthUser } from './jwt-verifier';

export const IS_PUBLIC_KEY = 'jewelry:isPublic';
export const ROLES_KEY = 'jewelry:roles';
export const AUDIENCE_KEY = 'jewelry:audience';

/** Bỏ qua kiểm tra token (mặc định mọi endpoint đều cần đăng nhập). Đặt được trên method hoặc class. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Loại token endpoint yêu cầu. Mặc định `backoffice`; endpoint của khách đặt `@Audience('shop')`. */
export const Audience = (audience: TokenAudience) => SetMetadata(AUDIENCE_KEY, audience);

/** Yêu cầu một trong các vai trò trên đúng chi nhánh của request. Xem `RolesGuard`. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Lấy user đã được `JwtGuard` xác thực: `@CurrentUser() user: AuthUser`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser | undefined =>
    context.switchToHttp().getRequest<{ user?: AuthUser }>().user,
);
