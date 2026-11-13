import { randomUUID, randomBytes } from 'node:crypto';
import {
  Audience,
  BusinessError,
  CurrentUser,
  Public,
  ZodValidationPipe,
  type AuthUser,
} from '@jewelry/common';
import { Body, Controller, Get, Header, HttpCode, Post, Req, Res } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import {
  customerLoginSchema as login,
  customerRegisterSchema as register,
  type CustomerLogin,
  type CustomerRegister,
} from '@jewelry/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenService } from './access-token.service';
import { generateRefreshToken, hashRefreshToken, refreshExpiry } from './tokens';
import { BCRYPT_ROUNDS } from '../password/hashing';

interface Request {
  headers: { cookie?: string };
}
interface Response {
  setHeader(name: string, value: string): unknown;
}
const cookie = (token: string, seconds: number) =>
  `rt_shop=${token}; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict; Path=/api/shop/auth`;
const refreshOf = (req: Request) =>
  req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('rt_shop='))
    ?.slice(8);
const conflict = () =>
  new BusinessError(
    'REFRESH_CONFLICT',
    'Phiên đang được cập nhật ở tab khác. Vui lòng thử lại.',
    409,
  );
const expired = () => new BusinessError('SESSION_EXPIRED', 'Vui lòng đăng nhập lại', 401);

@Audience('shop')
@Controller('shop/auth')
export class CustomerAuthController {
  private readonly decoy = hash(randomBytes(32).toString('hex'), BCRYPT_ROUNDS);
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AccessTokenService,
  ) {}

  private async open(
    account: { id: string; email: string; fullName: string },
    res: Response,
    started = new Date(),
  ) {
    const token = generateRefreshToken();
    const expiresAt = refreshExpiry(started);
    await this.prisma.customerSession.create({
      data: {
        id: randomUUID(),
        accountId: account.id,
        tokenHash: hashRefreshToken(token),
        expiresAt,
        sessionStartedAt: started,
      },
    });
    res.setHeader(
      'set-cookie',
      cookie(token, Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))),
    );
    return {
      accessToken: await this.tokens.sign(account.id, [], 'shop'),
      expiresIn: 900,
      user: { id: account.id, email: account.email, fullName: account.fullName },
    };
  }
  @Public()
  @Header('Cache-Control', 'no-store')
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(register)) body: CustomerRegister,
    @Res({ passthrough: true }) res: Response,
  ) {
    const passwordHash = await hash(body.password, BCRYPT_ROUNDS);
    const result = await this.prisma.customerAccount.createMany({
      data: [{ id: randomUUID(), email: body.email, fullName: body.fullName, passwordHash }],
      skipDuplicates: true,
    });
    if (!result.count)
      throw new BusinessError('INVALID_CREDENTIALS', 'Không thể đăng ký với thông tin này', 409);
    return this.open(
      await this.prisma.customerAccount.findUniqueOrThrow({ where: { email: body.email } }),
      res,
    );
  }
  @Public()
  @Header('Cache-Control', 'no-store')
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(login)) body: CustomerLogin,
    @Res({ passthrough: true }) res: Response,
  ) {
    const account = await this.prisma.customerAccount.findUnique({ where: { email: body.email } });
    const matched = await compare(body.password, account?.passwordHash ?? (await this.decoy));
    if (!account || !matched)
      throw new BusinessError('INVALID_CREDENTIALS', 'Sai email hoặc mật khẩu', 401);
    return this.open(account, res);
  }
  @Public()
  @Header('Cache-Control', 'no-store')
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = refreshOf(req);
    if (!token) throw expired();
    const session = await this.prisma.customerSession.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
      include: { account: true },
    });
    if (session?.revokedAt && Date.now() - session.revokedAt.getTime() < 10000) throw conflict();
    if (session?.revokedAt) throw expired();
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      res.setHeader('set-cookie', cookie('', 0));
      throw expired();
    }
    // Atomic consumption prevents concurrent use of the same refresh credential.
    const consumed = await this.prisma.customerSession.updateMany({
      where: { id: session.id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    if (!consumed.count) throw conflict();
    return this.open(session.account, res, session.sessionStartedAt);
  }
  @Public()
  @Header('Cache-Control', 'no-store')
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = refreshOf(req);
    if (token)
      await this.prisma.customerSession.updateMany({
        where: { tokenHash: hashRefreshToken(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    res.setHeader('set-cookie', cookie('', 0));
  }
  @Header('Cache-Control', 'no-store')
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const account = await this.prisma.customerAccount.findUnique({
      where: { id: user.id },
      select: { id: true, email: true, fullName: true },
    });
    if (!account) throw expired();
    return account;
  }
}
