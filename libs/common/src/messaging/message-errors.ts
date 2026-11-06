/** Handler ném khi biết lỗi sẽ tự hết (đối tác bận...): thư được thử lại 5 s → 30 s → 5 phút rồi vào DLQ. */
export class TransientError extends Error {}

/** Handler ném khi thử lại vô ích (dữ liệu không tồn tại...): thư vào DLQ ngay. */
export class PermanentError extends Error {}

export type ErrorKind = 'TRANSIENT' | 'PERMANENT';

/** Mã Prisma của lỗi kết nối, hết giờ, xung đột ghi. */
const TRANSIENT_PRISMA_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2028',
  'P2034',
]);

/** Dạng lỗi từ `@prisma/adapter-pg`, xem `DriverCause`. */
const TRANSIENT_ADAPTER_KINDS = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
  'TransactionWriteConflict',
]);

const TRANSIENT_POSTGRES_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/**
 * Prisma 7 với adapter để chi tiết ở `meta.driverAdapterError.cause`, và deadlock có mã `P2010` chứ không
 * phải `P2034`, nên chỉ xem mã Prisma là không đủ.
 */
interface DriverCause {
  originalCode?: string;
  kind?: string;
  table?: string;
  constraint?: { index?: string };
}

interface PrismaLikeError {
  code?: unknown;
  meta?: { modelName?: string; driverAdapterError?: { cause?: DriverCause } };
}

const driverCause = (error: PrismaLikeError): DriverCause | undefined =>
  error.meta?.driverAdapterError?.cause;

/** Phân loại lỗi của handler. Không nhận ra thì coi là vĩnh viễn: thà vào DLQ để người xem còn hơn thử mù. */
export function classifyError(error: unknown): ErrorKind {
  if (error instanceof TransientError) {
    return 'TRANSIENT';
  }
  if (error instanceof PermanentError || typeof error !== 'object' || error === null) {
    return 'PERMANENT';
  }
  const prisma = error as PrismaLikeError;
  const code = typeof prisma.code === 'string' ? prisma.code : '';
  const cause = driverCause(prisma);
  const transient =
    TRANSIENT_PRISMA_CODES.has(code) ||
    TRANSIENT_NODE_CODES.has(code) ||
    TRANSIENT_POSTGRES_CODES.has(cause?.originalCode ?? '') ||
    (cause?.originalCode ?? '').startsWith('08') ||
    TRANSIENT_ADAPTER_KINDS.has(cause?.kind ?? '') ||
    (error as Error).name === 'PrismaClientInitializationError';
  return transient ? 'TRANSIENT' : 'PERMANENT';
}

/**
 * Đúng là trùng khoá chính của `ProcessedEvent`, tức thư này đã xử lý rồi. `P2002` của bảng khác trong
 * handler là lỗi thật: nếu coi nhầm là đã xử lý, thư sẽ bị ack và mất. Prisma 7 không còn `meta.target`.
 */
export function isDuplicateProcessedEvent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const prisma = error as PrismaLikeError;
  return (
    prisma.code === 'P2002' &&
    prisma.meta?.modelName === 'ProcessedEvent' &&
    driverCause(prisma)?.constraint?.index === 'ProcessedEvent_pkey'
  );
}
