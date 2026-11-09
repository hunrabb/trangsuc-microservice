import type { DeadLetterMessage } from '@jewelry/contracts';

export type DlqListState = 'LOADING' | 'ERROR' | 'EMPTY' | 'READY';

/** Gom trạng thái danh sách để UI luôn ưu tiên lỗi, rồi mới tới loading/rỗng/dữ liệu. */
export function dlqListState(input: {
  loading: boolean;
  error: boolean;
  itemCount: number;
}): DlqListState {
  if (input.error) return 'ERROR';
  if (input.loading) return 'LOADING';
  if (input.itemCount === 0) return 'EMPTY';
  return 'READY';
}

/** Nút replay chỉ hiện cho ADMIN và thư đã được backend đánh dấu đủ điều kiện. */
export function canReplayDeadLetter(admin: boolean, message: DeadLetterMessage): boolean {
  return admin && message.replayable;
}
