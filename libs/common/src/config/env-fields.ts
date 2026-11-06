import { z } from 'zod';

/** Khối dựng schema cấu hình. Schema của từng app vẫn nằm trong app đó (`src/config/env.ts`). */
export const requiredEnv = (kind: string) =>
  z.string({ error: (issue) => (issue.input === undefined ? 'thiếu biến' : `phải là ${kind}`) });

export const nodeEnvField = z.enum(['development', 'test', 'production']).default('development');

export const portField = requiredEnv('số cổng')
  .regex(/^\d+$/, 'phải là số nguyên')
  .transform(Number)
  .pipe(z.number().int().min(1, 'phải từ 1').max(65535, 'phải đến 65535'));

export const httpUrlField = requiredEnv('URL').pipe(
  z.url({ protocol: /^https?$/, error: 'phải là URL dạng http://host:port' }),
);

/** Không có giá trị mặc định cho URL kết nối / mật khẩu: thiếu là không được chạy. */
export const postgresUrlField = (dbSchema: string) =>
  requiredEnv('URL')
    .pipe(z.url({ protocol: /^postgres(ql)?$/, error: 'phải là URL dạng postgresql://...' }))
    .refine((value) => new URL(value).password !== '', 'URL thiếu mật khẩu')
    .refine(
      (value) => new URL(value).searchParams.get('schema') === dbSchema,
      `URL phải có ?schema=${dbSchema}`,
    );
