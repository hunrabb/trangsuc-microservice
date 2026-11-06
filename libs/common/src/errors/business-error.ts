import type { ErrorCode } from '@jewelry/contracts';

/** Lỗi có chủ đích: trả cho client đúng `code`, `message`, `details` và `httpStatus`. */
export class BusinessError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}
