import { createPrivateKey, type KeyObject, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService, loadPublicKeys } from '@jewelry/common';
import type { BranchRole } from '@jewelry/contracts';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { SignJWT } from 'jose';
import type { Env } from '../config/env';
import { ACCESS_TOKEN_TTL_SECONDS } from './tokens';

@Injectable()
export class AccessTokenService implements OnModuleInit {
  private privateKey?: KeyObject;

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** Khoá hỏng, hoặc `JWT_ACTIVE_KID` không có public key tương ứng thì mọi token phát ra đều vô dụng: không bật. */
  onModuleInit(): void {
    const kid = this.config.get('JWT_ACTIVE_KID', { infer: true });
    const publicKeys = loadPublicKeys(this.config.get('JWT_PUBLIC_KEYS_DIR', { infer: true }));
    if (!publicKeys.has(kid)) {
      throw new Error(`Không có public key cho JWT_ACTIVE_KID = ${kid}`);
    }
    this.privateKey = createPrivateKey(
      readFileSync(this.config.get('JWT_PRIVATE_KEY_PATH', { infer: true })),
    );
  }

  sign(userId: string, branches: BranchRole[]): Promise<string> {
    return new SignJWT({ branches })
      .setProtectedHeader({
        alg: 'RS256',
        typ: 'JWT',
        kid: this.config.get('JWT_ACTIVE_KID', { infer: true }),
      })
      .setSubject(userId)
      .setIssuer(this.config.get('JWT_ISSUER', { infer: true }))
      .setAudience(this.config.get('JWT_AUDIENCE_BACKOFFICE', { infer: true }))
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .setJti(randomUUID())
      .sign(this.privateKey as KeyObject);
  }
}
