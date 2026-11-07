import { createPrivateKey, type KeyObject, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService, exitWithFatalLog, loadPublicKey } from '@jewelry/common';
import type { BranchRole } from '@jewelry/contracts';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { SignJWT } from 'jose';
import { type Env, SERVICE_NAME } from '../config/env';
import { isMatchingKeyPair } from './key-pair';
import { ACCESS_TOKEN_TTL_SECONDS } from './tokens';

@Injectable()
export class AccessTokenService implements OnModuleInit {
  private privateKey?: KeyObject;

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** Private và public không phải một cặp thì mọi token phát ra đều bị từ chối: không bật. */
  onModuleInit(): void {
    const privateKey = createPrivateKey(
      readFileSync(this.config.get('JWT_PRIVATE_KEY_PATH', { infer: true })),
    );
    const publicKey = loadPublicKey(this.config.get('JWT_PUBLIC_KEY_PATH', { infer: true }));
    if (!isMatchingKeyPair(privateKey, publicKey)) {
      exitWithFatalLog(
        SERVICE_NAME,
        'Dịch vụ không khởi động: JWT private key và public key không phải một cặp',
      );
    }
    this.privateKey = privateKey;
  }

  sign(userId: string, branches: BranchRole[]): Promise<string> {
    return new SignJWT({ branches })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(this.config.get('JWT_ISSUER', { infer: true }))
      .setAudience(this.config.get('JWT_AUDIENCE_BACKOFFICE', { infer: true }))
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .setJti(randomUUID())
      .sign(this.privateKey as KeyObject);
  }
}
