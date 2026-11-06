import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JWT_VERIFICATION, JwtGuard } from './jwt.guard';
import { type JwtVerification, loadPublicKeys } from './jwt-verifier';
import { RolesGuard } from './roles.guard';

/**
 * Bật `JwtGuard` rồi `RolesGuard` cho toàn app (thứ tự khai báo là thứ tự chạy).
 * Khoá được nạp lúc khởi động: thiếu hoặc hỏng thì service không bật; đổi khoá cần khởi động lại.
 */
@Module({
  providers: [
    {
      provide: JWT_VERIFICATION,
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtVerification => ({
        keys: loadPublicKeys(config.getOrThrow<string>('JWT_PUBLIC_KEYS_DIR')),
        issuer: config.getOrThrow<string>('JWT_ISSUER'),
        audience: config.getOrThrow<string>('JWT_AUDIENCE'),
      }),
    },
    JwtGuard,
    { provide: APP_GUARD, useExisting: JwtGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [JwtGuard],
})
export class JwtAuthModule {}
