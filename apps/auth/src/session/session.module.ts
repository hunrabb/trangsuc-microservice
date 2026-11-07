import { Module } from '@nestjs/common';
import { GoogleLoginService } from '../google/google-login.service';
import { PasswordService } from '../password/password.service';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { RefreshTokenCleanupJob } from './refresh-token-cleanup';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    SessionService,
    GoogleLoginService,
    PasswordService,
    RefreshTokenCleanupJob,
  ],
})
export class SessionModule {}
