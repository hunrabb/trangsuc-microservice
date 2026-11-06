import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessError } from '../errors/business-error';
import { IS_PUBLIC_KEY } from './decorators';
import { type AuthUser, type JwtVerification, verifyAccessToken } from './jwt-verifier';

export const JWT_VERIFICATION = Symbol('JWT_VERIFICATION');

export interface AuthenticatableRequest {
  headers: { authorization?: string };
  user?: AuthUser;
}

const BEARER = /^Bearer +(\S+)$/i;

/** Đăng ký toàn cục: mọi endpoint cần token hợp lệ, trừ `@Public()`. Gắn `req.user`. */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(JWT_VERIFICATION) private readonly verification: JwtVerification,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isPublic) {
      await this.authenticate(context.switchToHttp().getRequest<AuthenticatableRequest>());
    }
    return true;
  }

  /** Kiểm tra token của request; gateway gọi trực tiếp sau khi tra bảng định tuyến. */
  async authenticate(request: AuthenticatableRequest): Promise<AuthUser> {
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (token === undefined) {
      throw new BusinessError('INVALID_TOKEN', 'Thiếu token', 401);
    }
    const user = await verifyAccessToken(token, this.verification);
    request.user = user;
    return user;
  }
}
