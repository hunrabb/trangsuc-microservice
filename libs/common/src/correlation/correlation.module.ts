import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CORRELATION_ID_HEADER, resolveCorrelationId } from './correlation-id';

interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface OutgoingResponse {
  setHeader(name: string, value: string): unknown;
}

/** Gắn correlationId vào mỗi request và trả lại trong header phản hồi. Đọc bằng `getCorrelationId()`. */
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: IncomingRequest) =>
          resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]),
        setup: (cls, _req, res: OutgoingResponse) => {
          res.setHeader(CORRELATION_ID_HEADER, cls.getId());
        },
      },
    }),
  ],
})
export class CorrelationModule {}
