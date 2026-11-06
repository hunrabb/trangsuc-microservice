import { jwtEnvFields, nodeEnvField, portField, postgresUrlField } from '@jewelry/common';
import { z } from 'zod';

export const SERVICE_NAME = 'inventory';
export const DB_SCHEMA = 'inventory';

export const envSchema = z.object({
  NODE_ENV: nodeEnvField,
  PORT: portField,
  DATABASE_URL: postgresUrlField(DB_SCHEMA),
  ...jwtEnvFields,
});

export type Env = z.infer<typeof envSchema>;
