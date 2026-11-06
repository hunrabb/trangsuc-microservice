import { Module } from '@nestjs/common';
import { GoogleLoginService } from '../google/google-login.service';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController],
  providers: [AccessTokenService, SessionService, GoogleLoginService],
})
export class SessionModule {}
