import type { IncomingMessage } from 'node:http';
import type { Options } from 'pino-http';

/** Không bao giờ ghi các header này ra log (CLAUDE.md mục 12). */
const SENSITIVE_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/** JSON ra stdout; mọi dòng có `service` và `correlationId` (`null` khi ở ngoài request, ví dụ lúc khởi động). */
export function buildLoggerOptions(
  service: string,
  getCorrelationId: () => string | undefined,
): Options {
  return {
    base: { service },
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ correlationId: getCorrelationId() ?? null }),
    redact: { paths: SENSITIVE_PATHS, remove: true },
    autoLogging: { ignore: (req: IncomingMessage) => req.url?.startsWith('/health') ?? false },
  };
}
