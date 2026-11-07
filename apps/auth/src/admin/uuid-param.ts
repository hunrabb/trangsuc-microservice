import { ZodValidationPipe } from '@jewelry/common';
import { z } from 'zod';

/** Id trên đường dẫn: sai dạng trả `400`, không để Prisma ném lỗi kiểu dữ liệu thành `500`. */
export const UUID_PARAM = new ZodValidationPipe(z.uuid());
