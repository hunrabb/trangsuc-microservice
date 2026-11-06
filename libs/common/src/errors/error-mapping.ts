import type { ErrorCode, ErrorResponse } from '@jewelry/contracts';
import { HttpException } from '@nestjs/common';
import { BusinessError } from './business-error';

const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'INVALID_TOKEN',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'INVALID_STATE',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  502: 'SERVICE_UNAVAILABLE',
  503: 'SERVICE_UNAVAILABLE',
  504: 'SERVICE_UNAVAILABLE',
};

export const INTERNAL_ERROR_MESSAGE = 'Hệ thống gặp lỗi, vui lòng thử lại sau';
export const UNAVAILABLE_MESSAGE = 'Dịch vụ tạm thời không sẵn sàng, vui lòng thử lại sau';

/** Mã lỗi cho một status HTTP. 4xx không có trong bảng coi là request sai; 5xx coi là lỗi nội bộ. */
export function codeForStatus(status: number): ErrorCode {
  return CODE_BY_STATUS[status] ?? (status < 500 ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR');
}

export interface MappedError {
  status: number;
  body: ErrorResponse;
  /** Lỗi không lường trước: phải ghi log kèm stack. */
  unexpected: boolean;
}

function internalError(correlationId: string): MappedError {
  return {
    status: 500,
    body: { code: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MESSAGE, correlationId },
    unexpected: true,
  };
}

function fromHttpException(exception: HttpException, correlationId: string): MappedError {
  const status = exception.getStatus();
  const code = codeForStatus(status);
  if (code === 'SERVICE_UNAVAILABLE') {
    return {
      status,
      body: { code, message: UNAVAILABLE_MESSAGE, correlationId },
      unexpected: false,
    };
  }
  if (status >= 500) {
    return internalError(correlationId);
  }
  return { status, body: { code, message: exception.message, correlationId }, unexpected: false };
}

/** Đổi mọi exception thành phản hồi theo định dạng chung. Không có gì của lỗi lạ được lọt ra ngoài. */
export function toErrorResponse(exception: unknown, correlationId: string): MappedError {
  if (exception instanceof BusinessError) {
    const { code, message, details, httpStatus } = exception;
    return {
      status: httpStatus,
      body: { code, message, ...(details ? { details } : {}), correlationId },
      unexpected: false,
    };
  }
  if (exception instanceof HttpException) {
    return fromHttpException(exception, correlationId);
  }
  return internalError(correlationId);
}
