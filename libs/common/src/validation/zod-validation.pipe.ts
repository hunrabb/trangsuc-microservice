import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { BusinessError } from '../errors/business-error';

/** Kiểm tra dữ liệu vào bằng schema zod: `@Body(new ZodValidationPipe(schema)) dto: Dto`. */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  private readonly schema: S;

  constructor(schema: S) {
    this.schema = schema;
  }

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    const fields = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    throw new BusinessError('VALIDATION_FAILED', 'Dữ liệu không hợp lệ', 400, { fields });
  }
}
