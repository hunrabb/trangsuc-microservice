import { pino } from 'pino';
import { z } from 'zod';

export const SERVICE_NAME = 'auth';
const DB_SCHEMA = 'auth';

const required = (kind: string) =>
  z.string({ error: (issue) => (issue.input === undefined ? 'thiếu biến' : `phải là ${kind}`) });

const port = required('số cổng')
  .regex(/^\d+$/, 'phải là số nguyên')
  .transform(Number)
  .pipe(z.number().int().min(1, 'phải từ 1').max(65535, 'phải đến 65535'));

// Không có giá trị mặc định cho URL kết nối / mật khẩu: thiếu là không được chạy.
const databaseUrl = required('URL')
  .pipe(z.url({ protocol: /^postgres(ql)?$/, error: 'phải là URL dạng postgresql://...' }))
  .refine((value) => new URL(value).password !== '', 'URL thiếu mật khẩu')
  .refine(
    (value) => new URL(value).searchParams.get('schema') === DB_SCHEMA,
    `URL phải có ?schema=${DB_SCHEMA}`,
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: port,
  DATABASE_URL: databaseUrl,
});

export type Env = z.infer<typeof envSchema>;

export interface EnvProblem {
  variable: string;
  problem: string;
}

export type EnvResult = { ok: true; env: Env } | { ok: false; problems: EnvProblem[] };

export function parseEnv(raw: Record<string, unknown>): EnvResult {
  const result = envSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, env: result.data };
  }
  const seen = new Set<string>();
  const problems: EnvProblem[] = [];
  for (const issue of result.error.issues) {
    const variable = String(issue.path[0] ?? '(không rõ)');
    if (!seen.has(variable)) {
      seen.add(variable);
      problems.push({ variable, problem: issue.message });
    }
  }
  return { ok: false, problems };
}

/** Dùng cho ConfigModule: cấu hình sai thì ghi log rõ tên biến rồi thoát mã 1. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = parseEnv(raw);
  if (result.ok) {
    return result.env;
  }
  const list = result.problems.map((p) => `${p.variable} (${p.problem})`).join(', ');
  pino(
    { base: { service: SERVICE_NAME }, formatters: { level: (label) => ({ level: label }) } },
    pino.destination({ dest: 1, sync: true }),
  ).fatal({ problems: result.problems }, `Cấu hình không hợp lệ, dịch vụ không khởi động: ${list}`);
  process.exit(1);
}
