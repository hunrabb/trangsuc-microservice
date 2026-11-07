import { Alert, Button, List } from '@mantine/core';
import { isApiError } from '../api/api-error.ts';
import { describeError } from '../api/messages.ts';

/** Tên trường trong form ứng với đường dẫn lỗi của server (`assignments.0.branchId` → `assignments`). */
export const fieldKey = (field: string): string =>
  field.startsWith('assignments') ? 'assignments' : field;

/**
 * Lỗi chung của một biểu mẫu.
 * - `VALIDATION_FAILED`: lỗi của trường có trong `boundFields` đã hiện cạnh trường; ở đây chỉ hiện phần còn
 *   lại, để không bao giờ nuốt mất một lỗi.
 * - `VERSION_CONFLICT`: kèm nút tải lại dữ liệu.
 */
export function ErrorAlert({
  error,
  onReload,
  boundFields = [],
}: {
  error: unknown;
  onReload?: () => void;
  boundFields?: string[];
}) {
  if (error === null || error === undefined) {
    return null;
  }
  if (isApiError(error) && error.code === 'VALIDATION_FAILED') {
    const unbound = Object.entries(error.fieldErrors()).filter(
      ([field]) => !boundFields.includes(fieldKey(field)),
    );
    const noFields = Object.keys(error.fieldErrors()).length === 0;
    if (!noFields && unbound.length === 0) {
      return null;
    }
    return (
      <Alert color="red" mb="md">
        {describeError(error)}
        <List size="sm" mt="xs">
          {unbound.map(([field, message]) => (
            <List.Item key={field}>{message}</List.Item>
          ))}
        </List>
      </Alert>
    );
  }
  const conflict = isApiError(error) && error.code === 'VERSION_CONFLICT';
  return (
    <Alert color="red" mb="md">
      {describeError(error)}
      {conflict && onReload !== undefined && (
        <Button size="compact-sm" variant="light" color="red" ml="sm" onClick={onReload}>
          Tải lại
        </Button>
      )}
    </Alert>
  );
}

/** Lỗi theo trường, đã đổi tên trường cho khớp form. Rỗng nếu không phải `VALIDATION_FAILED`. */
export function boundFieldErrors(error: unknown, known: string[]): Record<string, string> {
  if (!isApiError(error)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [field, message] of Object.entries(error.fieldErrors())) {
    const key = fieldKey(field);
    if (known.includes(key) && result[key] === undefined) {
      result[key] = message;
    }
  }
  return result;
}
