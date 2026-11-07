import { httpUrlField, ipListField, jwtEnvFields, nodeEnvField, portField } from '@jewelry/common';
import { z } from 'zod';

export const SERVICE_NAME = 'gateway';

/** Hai nginx trong mạng Compose (docker-compose.yml), không phải cả mạng: xem chú thích ở đó. */
const DEFAULT_TRUSTED_PROXIES = '172.30.0.16/31';

export const envSchema = z.object({
  NODE_ENV: nodeEnvField,
  PORT: portField,
  // Địa chỉ nội bộ của các service, ví dụ http://inventory:3000 (không có mặc định).
  AUTH_URL: httpUrlField,
  INVENTORY_URL: httpUrlField,
  SALES_URL: httpUrlField,
  REPORT_URL: httpUrlField,
  ...jwtEnvFields,
  TRUSTED_PROXIES: ipListField.default(DEFAULT_TRUSTED_PROXIES),
});

export type Env = z.infer<typeof envSchema>;
