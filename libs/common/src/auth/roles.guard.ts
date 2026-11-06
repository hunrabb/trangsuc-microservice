import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@jewelry/contracts';
import { BusinessError } from '../errors/business-error';
import { ROLES_KEY } from './decorators';
import type { AuthUser } from './jwt-verifier';

interface BranchScopedRequest {
  user?: AuthUser;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

const forbidden = () =>
  new BusinessError('FORBIDDEN', 'Không có quyền thực hiện thao tác này', 403);

/**
 * Lấy chi nhánh của request. **Quy ước:** tên trường luôn là `branchId`, đọc từ route param, query và body.
 * - Không có ở đâu → `undefined`.
 * - Có ở nhiều nơi phải **cùng một giá trị**. Nếu không, kẻ có quyền ở chi nhánh A có thể gửi
 *   `?branchId=A` kèm body `branchId=B`, qua kiểm tra bằng A rồi handler lại ghi vào B.
 * - Không phải chuỗi (ví dụ `?branchId=a&branchId=b` thành mảng) → từ chối.
 */
export function resolveBranchId(request: BranchScopedRequest): string | undefined {
  const body = request.body;
  const fromBody =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).branchId
      : undefined;
  const values = [request.params?.branchId, request.query?.branchId, fromBody].filter(
    (value) => value !== undefined,
  );
  if (values.length === 0) {
    return undefined;
  }
  const [first] = values;
  if (typeof first !== 'string' || values.some((value) => value !== first)) {
    throw forbidden();
  }
  return first;
}

/**
 * Đăng ký toàn cục, chạy sau `JwtGuard`. Endpoint không có `@Roles` thì chỉ cần đăng nhập.
 * - `ADMIN` (`branchId = null`) luôn qua, không phụ thuộc chi nhánh của request.
 * - Vai trò khác phải khớp cả vai trò lẫn chi nhánh (`resolveBranchId`). Request không nêu chi nhánh
 *   thì không xác định được phạm vi nên bị từ chối.
 * - Không đạt → `403 FORBIDDEN`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles === undefined) {
      return true;
    }
    const request = context.switchToHttp().getRequest<BranchScopedRequest>();
    const user = request.user;
    if (user === undefined) {
      throw forbidden();
    }
    if (user.branches.some(({ role, branchId }) => role === 'ADMIN' && branchId === null)) {
      return true;
    }
    const branchId = resolveBranchId(request);
    const allowed =
      branchId !== undefined &&
      user.branches.some((entry) => entry.branchId === branchId && roles.includes(entry.role));
    if (!allowed) {
      throw forbidden();
    }
    return true;
  }
}
