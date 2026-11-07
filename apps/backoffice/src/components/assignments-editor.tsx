import type { BranchRole } from '@jewelry/contracts';
import { Button, Group, Input, Select, Stack, Text, CloseButton } from '@mantine/core';
import { ROLE_LABELS } from '../auth/permissions.ts';

export interface BranchOption {
  value: string;
  label: string;
}

type Role = BranchRole['role'];

/**
 * Danh sách (vai trò, chi nhánh). ADMIN áp dụng toàn hệ thống nên không chọn chi nhánh. Chi nhánh chưa chọn
 * được giữ là chuỗi rỗng trong lúc sửa; biểu mẫu phải kiểm trước khi gửi (`hasIncompleteAssignment`).
 */
export function AssignmentsEditor({
  value,
  onChange,
  roles,
  branches,
  error,
}: {
  value: BranchRole[];
  onChange(next: BranchRole[]): void;
  roles: Role[];
  branches: BranchOption[];
  error?: string | undefined;
}) {
  const update = (index: number, patch: Partial<BranchRole>) =>
    onChange(value.map((item, at) => (at === index ? { ...item, ...patch } : item)));

  const changeRole = (index: number, role: Role) =>
    update(index, {
      role,
      branchId: role === 'ADMIN' ? null : (value[index]?.branchId ?? branches[0]?.value ?? ''),
    });

  const add = () => {
    const role: Role = roles.includes('STAFF') ? 'STAFF' : (roles[0] ?? 'STAFF');
    onChange([...value, { role, branchId: role === 'ADMIN' ? null : '' }]);
  };

  return (
    <Input.Wrapper label="Vai trò" error={error}>
      <Stack gap="xs" mt={4}>
        {value.map((item, index) => (
          <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
            <Select
              aria-label="Vai trò"
              w={150}
              allowDeselect={false}
              value={item.role}
              data={roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
              onChange={(role) => role !== null && changeRole(index, role as Role)}
            />
            {item.role === 'ADMIN' ? (
              <Text size="sm" c="dimmed" pt={6} style={{ flex: 1 }}>
                Toàn hệ thống
              </Text>
            ) : (
              <Select
                aria-label="Chi nhánh"
                placeholder="Chọn chi nhánh"
                style={{ flex: 1 }}
                allowDeselect={false}
                value={item.branchId === '' ? null : item.branchId}
                data={branches}
                onChange={(branchId) => update(index, { branchId: branchId ?? '' })}
              />
            )}
            <CloseButton
              aria-label="Bỏ vai trò này"
              disabled={value.length <= 1}
              onClick={() => onChange(value.filter((_, at) => at !== index))}
            />
          </Group>
        ))}
        <Button
          size="compact-sm"
          variant="subtle"
          onClick={add}
          style={{ alignSelf: 'flex-start' }}
        >
          Thêm vai trò
        </Button>
      </Stack>
    </Input.Wrapper>
  );
}

/** Có dòng chưa chọn chi nhánh. */
export const hasIncompleteAssignment = (assignments: readonly BranchRole[]): boolean =>
  assignments.some(
    ({ role, branchId }) => role !== 'ADMIN' && (branchId === null || branchId === ''),
  );

export const hasAdminRole = (assignments: readonly BranchRole[]): boolean =>
  assignments.some(({ role }) => role === 'ADMIN');
