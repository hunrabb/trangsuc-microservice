import {
  databasePoolMaxField,
  jwtEnvFields,
  nodeEnvField,
  portField,
  postgresUrlField,
  rabbitUrlField,
} from '@jewelry/common';
import { z } from 'zod';

export const SERVICE_NAME = 'sales';
export const DB_SCHEMA = 'sales';

export const envSchema = z.object({
  NODE_ENV: nodeEnvField,
  PORT: portField,
  DATABASE_URL: postgresUrlField(DB_SCHEMA),
  DATABASE_POOL_MAX: databasePoolMaxField,
  RABBITMQ_URL: rabbitUrlField,
  ...jwtEnvFields,
});

export type Env = z.infer<typeof envSchema>;
