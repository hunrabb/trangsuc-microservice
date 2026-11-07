import {
  type AuthUser as TokenUser,
  BusinessError,
  CurrentUser,
  Public,
  Roles,
  ZodValidationPipe,
} from '@jewelry/common';
import {
  type AuthSession,
  type ChangePasswordRequest,
  changePasswordRequestSchema,
  type CurrentUser as CurrentUserResponse,
  type GoogleLoginRequest,
  googleLoginRequestSchema,
  type PasswordLoginRequest,
  passwordLoginRequestSchema,
} from '@jewelry/contracts';
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { GoogleLoginService } from '../google/google-login.service';
import { PasswordService } from '../password/password.service';
import { type ClientInfo, type OpenedSession, SessionService } from './session.service';
import { clearedRefreshCookie, readRefreshCookie, refreshCookie } from './tokens';

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface HttpResponse {
  setHeader(name: string, value: string): unknown;
}

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Service chỉ nhận request từ gateway, và gateway tự đặt `x-forwarded-for`. */
const clientInfo = ({ headers }: HttpRequest): ClientInfo => ({
  userAgent: headerValue(headers['user-agent']),
  ip: headerValue(headers['x-forwarded-for']),
});

const refreshTokenOf = ({ headers }: HttpRequest) => readRefreshCookie(headerValue(headers.cookie));

function withCookie(response: HttpResponse, opened: OpenedSession): AuthSession {
  response.setHeader('set-cookie', refreshCookie(opened.refreshToken, opened.refreshExpiresAt));
  return opened.session;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly google: GoogleLoginService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('google')
  @HttpCode(200)
  async loginWithGoogle(
    @Body(new ZodValidationPipe(googleLoginRequestSchema)) body: GoogleLoginRequest,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<AuthSession> {
    return withCookie(response, await this.google.login(body.credential, clientInfo(request)));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async loginWithPassword(
    @Body(new ZodValidationPipe(passwordLoginRequestSchema)) body: PasswordLoginRequest,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<AuthSession> {
    const opened = await this.passwords.login(body.email, body.password, clientInfo(request));
    return withCookie(response, opened);
  }

  @Roles('ADMIN')
  @Post('change-password')
  @HttpCode(204)
  changePassword(
    @CurrentUser() user: TokenUser,
    @Body(new ZodValidationPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
    @Req() request: HttpRequest,
  ): Promise<void> {
    return this.passwords.change(user.id, body, refreshTokenOf(request), clientInfo(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<AuthSession> {
    const token = refreshTokenOf(request);
    try {
      if (token === undefined) {
        throw new BusinessError('SESSION_EXPIRED', 'Phiên đăng nhập đã hết hạn', 401);
      }
      return withCookie(response, await this.sessions.refresh(token, clientInfo(request)));
    } catch (error) {
      // Phiên đã hết thì bỏ cookie luôn. `REFRESH_CONFLICT` thì giữ: cookie mới là của tab thắng.
      if (error instanceof BusinessError && error.code === 'SESSION_EXPIRED') {
        response.setHeader('set-cookie', clearedRefreshCookie());
      }
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    await this.sessions.logout(refreshTokenOf(request));
    response.setHeader('set-cookie', clearedRefreshCookie());
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @CurrentUser() user: TokenUser,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    await this.sessions.logoutAll(user.id);
    response.setHeader('set-cookie', clearedRefreshCookie());
  }

  @Get('me')
  me(@CurrentUser() user: TokenUser): Promise<CurrentUserResponse> {
    return this.sessions.currentUser(user.id);
  }
}
