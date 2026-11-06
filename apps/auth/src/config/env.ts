import {
  databasePoolMaxField,
  httpUrlField,
  jwtEnvFields,
  jwtSigningEnvFields,
  nodeEnvField,
  portField,
  postgresUrlField,
  rabbitUrlField,
  requiredEnv,
} from '@jewelry/common';
import { z } from 'zod';

export const SERVICE_NAME = 'auth';
export const DB_SCHEMA = 'auth';
const GOOGLE_JWKS_DEFAULT_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export const envSchema = z.object({
  NODE_ENV: nodeEnvField,
  PORT: portField,
  DATABASE_URL: postgresUrlField(DB_SCHEMA),
  DATABASE_POOL_MAX: databasePoolMaxField,
  RABBITMQ_URL: rabbitUrlField,
  ...jwtEnvFields,
  ...jwtSigningEnvFields,
  // Client ID của OAuth, không phải bí mật. Bắt buộc: ID token phải có đúng `aud` này.
  GOOGLE_CLIENT_ID: requiredEnv('chuỗi').min(1, 'không được để trống'),
  GOOGLE_JWKS_URL: httpUrlField.default(GOOGLE_JWKS_DEFAULT_URL),
});

export type Env = z.infer<typeof envSchema>;
