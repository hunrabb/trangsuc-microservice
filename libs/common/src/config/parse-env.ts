import { pino } from 'pino';
import type { z } from 'zod';

export interface EnvProblem {
  variable: string;
  problem: string;
}

export type EnvResult<T> = { ok: true; env: T } | { ok: false; problems: EnvProblem[] };

/** Kiểm tra biến môi trường theo schema; mỗi biến sai chỉ báo một lần. */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  raw: Record<string, unknown>,
): EnvResult<z.output<S>> {
  const result = schema.safeParse(raw);
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

/** Cấu hình sai thì ghi log rõ tên biến rồi thoát mã 1. Logger đồng bộ để dòng log kịp ra trước khi thoát. */
export function validateEnv<S extends z.ZodType>(
  schema: S,
  raw: Record<string, unknown>,
  service: string,
): z.output<S> {
  const result = parseEnv(schema, raw);
  if (result.ok) {
    return result.env;
  }
  const list = result.problems.map((p) => `${p.variable} (${p.problem})`).join(', ');
  pino(
    { base: { service }, formatters: { level: (label) => ({ level: label }) } },
    pino.destination({ dest: 1, sync: true }),
  ).fatal({ problems: result.problems }, `Cấu hình không hợp lệ, dịch vụ không khởi động: ${list}`);
  process.exit(1);
}
