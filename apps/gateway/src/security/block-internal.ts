/**
 * Chốt chặn: gateway KHÔNG BAO GIỜ đưa đường /internal/* ra ngoài (CLAUDE.md mục 10).
 * Hiện gateway chưa chuyển tiếp gì cả; middleware này giữ cho điều đó vẫn đúng khi sau này
 * có thêm lớp định tuyến/proxy. Trả đúng dạng 404 mặc định của Nest để không lộ sự tồn tại.
 */
interface BlockedRequest {
  method: string;
  originalUrl: string;
}

interface JsonResponse {
  status(code: number): JsonResponse;
  json(body: unknown): unknown;
}

export const INTERNAL_PREFIX = '/internal';

export function blockInternal(req: BlockedRequest, res: JsonResponse): void {
  res.status(404).json({
    message: `Cannot ${req.method} ${req.originalUrl}`,
    error: 'Not Found',
    statusCode: 404,
  });
}
