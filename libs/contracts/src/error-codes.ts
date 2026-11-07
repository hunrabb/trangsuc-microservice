import { z } from 'zod';

/** Mã lỗi chung. Mã nghiệp vụ (OUT_OF_STOCK...) thêm vào đây ở giai đoạn sau; chỉ được thêm, không đổi tên hay xoá. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_NOT_PROVISIONED',
  'SESSION_EXPIRED',
  'REFRESH_CONFLICT',
  'PASSWORD_TOO_WEAK',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'VERSION_CONFLICT',
  'INVALID_STATE',
  'LAST_ADMIN',
  'METAL_PRICE_NOT_SET',
  'ITEM_NOT_AVAILABLE',
  'INVALID_ITEM_STATE',
  'IDEMPOTENCY_KEY_REUSED',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
