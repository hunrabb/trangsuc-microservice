import { z } from 'zod';
import { errorCodeSchema } from './error-codes';

/** Định dạng lỗi thống nhất của mọi service (CLAUDE.md mục 10). */
export const errorResponseSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  correlationId: z.string(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
