import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JWT_VERIFICATION, JwtGuard } from './jwt.guard';
import { type JwtVerification, loadPublicKey } from './jwt-verifier';
import { RolesGuard } from './roles.guard';

/**
 * Bật `JwtGuard` rồi `RolesGuard` cho toàn app (thứ tự khai báo là thứ tự chạy).
 * Khoá được nạp lúc khởi động: thiếu hoặc hỏng thì service không bật; đổi khoá cần khởi động lại mọi service.
 */
@Module({
  providers: [
    {
      provide: JWT_VERIFICATION,
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtVerification => ({
        publicKey: loadPublicKey(config.getOrThrow<string>('JWT_PUBLIC_KEY_PATH')),
        issuer: config.getOrThrow<string>('JWT_ISSUER'),
        audiences: {
          backoffice: config.getOrThrow<string>('JWT_AUDIENCE_BACKOFFICE'),
          shop: config.getOrThrow<string>('JWT_AUDIENCE_SHOP'),
        },
      }),
    },
    JwtGuard,
    { provide: APP_GUARD, useExisting: JwtGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [JwtGuard],
})
export class JwtAuthModule {}
