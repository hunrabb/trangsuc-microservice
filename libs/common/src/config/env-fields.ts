import { accessSync, constants, statSync } from 'node:fs';
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

/** Không có mặc định: thiếu là không được chạy. Dùng user ứng dụng, không dùng tài khoản quản trị. */
export const rabbitUrlField = requiredEnv('URL')
  .pipe(z.url({ protocol: /^amqps?$/, error: 'phải là URL dạng amqp://user:pass@host:5672' }))
  .refine((value) => new URL(value).password !== '', 'URL thiếu mật khẩu');

const nonEmptyEnv = (kind: string) => requiredEnv(kind).min(1, 'không được để trống');

/** Có file và tiến trình đọc được: mount sai hoặc sai quyền thì dịch vụ không bật. */
function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const readableFileField = nonEmptyEnv('đường dẫn').refine(
  isReadableFile,
  'không đọc được file',
);

/** Kiểm tra token: mọi service. `JWT_PUBLIC_KEYS_DIR` chứa `<kid>.public.pem`, được nạp khi khởi động. */
export const jwtEnvFields = {
  JWT_PUBLIC_KEYS_DIR: nonEmptyEnv('đường dẫn'),
  JWT_ISSUER: nonEmptyEnv('chuỗi'),
  JWT_AUDIENCE: nonEmptyEnv('chuỗi'),
};

/** Ký token: chỉ auth. */
export const jwtSigningEnvFields = {
  JWT_PRIVATE_KEY_PATH: readableFileField,
  JWT_ACTIVE_KID: nonEmptyEnv('chuỗi'),
};
