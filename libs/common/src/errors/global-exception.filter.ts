import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import {
  CORRELATION_ID_HEADER,
  getCorrelationId,
  resolveCorrelationId,
} from '../correlation/correlation-id';
import { toErrorResponse } from './error-mapping';

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface HttpResponse {
  headersSent: boolean;
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
  end(): unknown;
}

/**
 * Bắt mọi lỗi của mọi app. Stack trace chỉ ghi log, không trả ra ngoài.
 * Lỗi xảy ra trước middleware correlationId (ví dụ body JSON hỏng) không có mã trong ngữ cảnh,
 * nên phải tự lấy từ header để phản hồi vẫn có `correlationId`.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const correlationId =
      getCorrelationId() ?? resolveCorrelationId(request.headers[CORRELATION_ID_HEADER]);

    const { status, body, unexpected } = toErrorResponse(exception, correlationId);
    if (unexpected) {
      this.logger.error(exception instanceof Error ? exception : String(exception));
    }
    if (response.headersSent) {
      response.end();
      return;
    }
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    response.status(status).json(body);
  }
}
