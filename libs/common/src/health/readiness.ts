/**
 * Một điều kiện để service nhận việc. `check` ném lỗi nghĩa là chưa sẵn sàng.
 * Thêm kiểm tra mới (ví dụ RabbitMQ) = thêm một phần tử vào danh sách truyền cho `HealthModule.forRoot`.
 */
export interface ReadinessCheck {
  name: string;
  check(): Promise<unknown>;
}

export type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, CheckStatus>;
}

export type ReadinessFailureHandler = (name: string, error: unknown) => void;

/** Phải nhỏ hơn `timeout` của healthcheck trong docker-compose.yml (5 s). */
export const READINESS_TIMEOUT_MS = 2000;

async function withTimeout(check: ReadinessCheck, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`quá ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([check.check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Chạy song song mọi kiểm tra; một kiểm tra hỏng hoặc treo không cản các kiểm tra khác. */
export async function runReadinessChecks(
  checks: readonly ReadinessCheck[],
  onFailure: ReadinessFailureHandler,
  timeoutMs: number = READINESS_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const entries = await Promise.all(
    checks.map(async (check): Promise<[string, CheckStatus]> => {
      try {
        await withTimeout(check, timeoutMs);
        return [check.name, 'up'];
      } catch (error) {
        onFailure(check.name, error);
        return [check.name, 'down'];
      }
    }),
  );
  return {
    ready: entries.every(([, status]) => status === 'up'),
    checks: Object.fromEntries(entries),
  };
}

/** Kết cấu tối thiểu của Prisma client. `libs/` không import Prisma: client nằm trong từng app. */
export interface RawQueryClient {
  $queryRawUnsafe(query: string): Promise<unknown>;
}

export function postgresCheck(client: RawQueryClient): ReadinessCheck {
  return { name: 'postgres', check: () => client.$queryRawUnsafe('SELECT 1') };
}
