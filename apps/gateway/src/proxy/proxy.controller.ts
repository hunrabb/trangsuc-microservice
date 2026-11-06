import type { IncomingMessage, ServerResponse } from 'node:http';
import { BusinessError, ConfigService, getCorrelationId } from '@jewelry/common';
import { All, Controller, Logger, Req, Res } from '@nestjs/common';
import type { Env } from '../config/env';
import { forwardRequestHeaders, forwardResponseHeaders } from './headers';
import { BodyTooLargeError, MAX_BODY_BYTES, readBody } from './read-body';
import { resolveRoute, type UpstreamService } from './routes';

/** Gateway không tự retry: client quyết định, vì POST có Idempotency-Key. */
export const PROXY_TIMEOUT_MS = 10_000;

const NO_BODY_METHODS = new Set(['GET', 'HEAD']);

type ProxyRequest = IncomingMessage & { originalUrl: string; method: string };

/** Khai báo sau các controller riêng của gateway (`/api/ping`) để không che chúng. */
@Controller()
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);
  private readonly upstreams: Record<UpstreamService, string>;

  constructor(config: ConfigService<Env, true>) {
    const origin = (key: 'AUTH_URL' | 'INVENTORY_URL' | 'SALES_URL' | 'REPORT_URL') =>
      new URL(config.get(key, { infer: true })).origin;
    this.upstreams = {
      auth: origin('AUTH_URL'),
      inventory: origin('INVENTORY_URL'),
      sales: origin('SALES_URL'),
      report: origin('REPORT_URL'),
    };
  }

  @All(['api{/*path}', 'webhooks{/*path}'])
  async forward(@Req() req: ProxyRequest, @Res() res: ServerResponse): Promise<void> {
    const route = resolveRoute(req.originalUrl);
    if (route === undefined) {
      throw new BusinessError('NOT_FOUND', `Cannot ${req.method} ${req.originalUrl}`, 404);
    }
    const body = await this.readRequestBody(req, res);

    let upstream: Response;
    let payload: Buffer;
    try {
      // Ghép chuỗi, không dùng new URL(path, base): route.path đã được kiểm tra và không được đổi host.
      upstream = await fetch(`${this.upstreams[route.service]}${route.path}`, {
        method: req.method,
        headers: forwardRequestHeaders(req.headers, getCorrelationId() ?? ''),
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
      payload = Buffer.from(await upstream.arrayBuffer());
    } catch (error) {
      this.logger.error(`Không chuyển tiếp được tới ${route.service}: ${String(error)}`);
      throw new BusinessError(
        'SERVICE_UNAVAILABLE',
        'Dịch vụ tạm thời không sẵn sàng, vui lòng thử lại sau',
        503,
      );
    }

    res.statusCode = upstream.status;
    for (const [name, value] of Object.entries(forwardResponseHeaders(upstream.headers))) {
      res.setHeader(name, value);
    }
    res.end(payload);
  }

  private async readRequestBody(
    req: ProxyRequest,
    res: ServerResponse,
  ): Promise<Buffer | undefined> {
    if (NO_BODY_METHODS.has(req.method)) {
      return undefined;
    }
    const tooLarge = () => {
      // Client có thể vẫn đang gửi: đóng kết nối sau phản hồi thay vì đọc tiếp phần thừa.
      res.setHeader('connection', 'close');
      return new BusinessError(
        'PAYLOAD_TOO_LARGE',
        `Nội dung vượt quá ${MAX_BODY_BYTES} byte`,
        413,
      );
    };
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      throw tooLarge();
    }
    try {
      return await readBody(req);
    } catch (error) {
      throw error instanceof BodyTooLargeError ? tooLarge() : error;
    }
  }
}
