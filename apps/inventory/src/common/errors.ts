import { BusinessError } from '@jewelry/common';

/** `400 VALIDATION_FAILED` với lỗi gắn vào từng trường, cùng định dạng `details.fields` của auth. */
export const fieldError = (...fields: { field: string; message: string }[]) =>
  new BusinessError('VALIDATION_FAILED', 'Dữ liệu không hợp lệ', 400, { fields });

export const notFound = (what: string) =>
  new BusinessError('NOT_FOUND', `Không tìm thấy ${what}`, 404);

export const versionConflict = () =>
  new BusinessError('VERSION_CONFLICT', 'Dữ liệu đã bị người khác sửa', 409);

export const invalidState = (message: string) => new BusinessError('INVALID_STATE', message, 409);

/** Trang `skip`/`take` từ `page`, `pageSize` đã kiểm tra bằng zod. */
export const pageArgs = ({ page, pageSize }: { page: number; pageSize: number }) => ({
  skip: (page - 1) * pageSize,
  take: pageSize,
});
