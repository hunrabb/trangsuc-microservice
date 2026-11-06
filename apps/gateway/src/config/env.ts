import { httpUrlField, nodeEnvField, portField } from '@jewelry/common';
import { z } from 'zod';

export const SERVICE_NAME = 'gateway';

export const envSchema = z.object({
  NODE_ENV: nodeEnvField,
  PORT: portField,
  // Địa chỉ nội bộ của các service, ví dụ http://inventory:3000 (không có mặc định).
  AUTH_URL: httpUrlField,
  INVENTORY_URL: httpUrlField,
  SALES_URL: httpUrlField,
  REPORT_URL: httpUrlField,
});

export type Env = z.infer<typeof envSchema>;
