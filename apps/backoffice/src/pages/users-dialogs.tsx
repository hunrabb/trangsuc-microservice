import type { BranchRole, User } from '@jewelry/contracts';
import { Button, Group, Modal, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { authApi } from '../api/endpoints.ts';
import { queryKeys, useBranchLabel, useBranchOptions } from '../api/queries.ts';
import { useActiveBranch } from '../auth/active-branch.tsx';
import { isAdmin, managedBranchIds } from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';
import {
  AssignmentsEditor,
  type BranchOption,
  hasAdminRole,
  hasIncompleteAssignment,
} from '../components/assignments-editor.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { boundFieldErrors, ErrorAlert } from '../components/error-alert.tsx';

const CREATE_FIELDS = ['email', 'fullName', 'phone', 'assignments', 'password'];

/** Chi nhánh có thể gán: ADMIN thấy mọi chi nhánh đang hoạt động; MANAGER chỉ chi nhánh mình quản lý. */
export function useAssignableBranches(): BranchOption[] {
  const { me } = useSession();
  const options = useBranchOptions();
  const label = useBranchLabel();
  return useMemo(() => {
    if (me === undefined) {
      return [];
    }
    if (isAdmin(me.branches)) {
      return (options.data?.items ?? [])
        .filter((branch) => branch.isActive)
        .map((branch) => ({ value: branch.id, label: `${branch.name} (${branch.code})` }));
    }
    return managedBranchIds(me.branches).map((id) => ({ value: id, label: label(id) }));
  }, [me, options.data, label]);
}

const sameAssignment = (a: BranchRole, b: BranchRole) =>
  a.role === b.role && a.branchId === b.branchId;

// ---------------------------------------------------------------- Tạo nhân viên

interface CreateValues {
  email: string;
  fullName: string;
  phone: string;
  assignments: BranchRole[];
  password: string;
}

/** Tạo nhân viên. MANAGER chỉ tạo được STAFF ở chi nhánh mình. Có vai trò ADMIN thì bắt buộc đặt mật khẩu. */
export function CreateUserModal({ onClose }: { onClose(): void }) {
  const { me } = useSession();
  const { activeBranchId } = useActiveBranch();
  const branches = useAssignableBranches();
  const queryClient = useQueryClient();
  const admin = me !== undefined && isAdmin(me.branches);

  const form = useForm<CreateValues>({
    initialValues: {
      email: '',
      fullName: '',
      phone: '',
      assignments: [
        {
          role: 'STAFF',
          branchId:
            branches.find((branch) => branch.value === activeBranchId)?.value ??
            branches[0]?.value ??
            '',
        },
      ],
      password: '',
    },
    validate: {
      email: (value) => (value.trim() === '' ? 'Nhập email' : null),
      fullName: (value) => (value.trim() === '' ? 'Nhập họ tên' : null),
      assignments: (value) =>
        hasIncompleteAssignment(value) ? 'Chọn chi nhánh cho mỗi vai trò' : null,
      password: (value, values) =>
        hasAdminRole(values.assignments) && value === '' ? 'Quản trị viên phải có mật khẩu' : null,
    },
  });
  const needsPassword = hasAdminRole(form.values.assignments);

  const create = useMutation({
    mutationFn: (values: CreateValues) => {
      const phone = values.phone.trim();
      return authApi.createUser({
        email: values.email.trim(),
        fullName: values.fullName.trim(),
        ...(phone === '' ? {} : { phone }),
        assignments: values.assignments,
        ...(hasAdminRole(values.assignments) ? { password: values.password } : {}),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.users });
      notifications.show({ color: 'green', message: 'Đã tạo nhân viên.' });
      onClose();
    },
    onError: (error) => form.setErrors(boundFieldErrors(error, CREATE_FIELDS)),
  });

  return (
    <Modal opened onClose={onClose} title="Thêm nhân viên" centered size="lg">
      <form onSubmit={form.onSubmit((values) => create.mutate(values))}>
        <ErrorAlert error={create.error} boundFields={CREATE_FIELDS} />
        <Stack>
          <TextInput label="Email" withAsterisk {...form.getInputProps('email')} />
          <TextInput label="Họ tên" withAsterisk {...form.getInputProps('fullName')} />
          <TextInput label="Điện thoại" {...form.getInputProps('phone')} />
          <AssignmentsEditor
            value={form.values.assignments}
            onChange={(next) => form.setFieldValue('assignments', next)}
            roles={admin ? ['ADMIN', 'MANAGER', 'STAFF'] : ['STAFF']}
            branches={branches}
            error={
              typeof form.errors.assignments === 'string' ? form.errors.assignments : undefined
            }
          />
          {needsPassword && (
            <PasswordInput
              label="Mật khẩu quản trị viên"
              description="Tối thiểu 12 ký tự. Quản trị viên đăng nhập được bằng mật khẩu."
              autoComplete="new-password"
              withAsterisk
              {...form.getInputProps('password')}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" loading={create.isPending}>
              Tạo
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Sửa thông tin

interface EditValues {
  fullName: string;
  phone: string;
}

/** Sửa họ tên, điện thoại. Gửi `version`: người khác vừa sửa thì nhận `VERSION_CONFLICT`. */
export function EditUserModal({ user, onClose }: { user: User; onClose(): void }) {
  const queryClient = useQueryClient();
  const form = useForm<EditValues>({
    initialValues: { fullName: user.fullName, phone: user.phone ?? '' },
    validate: { fullName: (value) => (value.trim() === '' ? 'Nhập họ tên' : null) },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.users });

  const save = useMutation({
    mutationFn: (values: EditValues) =>
      authApi.updateUser(user.id, {
        version: user.version,
        fullName: values.fullName.trim(),
        phone: values.phone.trim() === '' ? null : values.phone.trim(),
      }),
    onSuccess: async () => {
      await refresh();
      notifications.show({ color: 'green', message: 'Đã lưu thông tin nhân viên.' });
      onClose();
    },
    onError: (error) => form.setErrors(boundFieldErrors(error, ['fullName', 'phone'])),
  });

  return (
    <Modal opened onClose={onClose} title={`Sửa ${user.email}`} centered>
      <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
        <ErrorAlert
          error={save.error}
          boundFields={['fullName', 'phone']}
          onReload={() => {
            void refresh();
            onClose();
          }}
        />
        <Stack>
          <TextInput label="Họ tên" withAsterisk {...form.getInputProps('fullName')} />
          <TextInput label="Điện thoại" {...form.getInputProps('phone')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" loading={save.isPending}>
              Lưu
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Gán vai trò (chỉ ADMIN)

/**
 * Thay toàn bộ vai trò. Thêm ADMIN → bắt nhập mật khẩu. Bớt bất kỳ vai trò nào → hỏi xác nhận, vì người đó
 * bị đăng xuất khỏi mọi thiết bị; bỏ ADMIN còn xoá mật khẩu.
 */
export function AssignRolesModal({ user, onClose }: { user: User; onClose(): void }) {
  const branches = useAssignableBranches();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const form = useForm<{ assignments: BranchRole[]; password: string }>({
    initialValues: { assignments: user.branches, password: '' },
  });
  const { assignments, password } = form.values;

  const adding = hasAdminRole(assignments) && !hasAdminRole(user.branches);
  const removesAdmin = hasAdminRole(user.branches) && !hasAdminRole(assignments);
  const removing = user.branches.some(
    (old) => !assignments.some((next) => sameAssignment(old, next)),
  );

  const save = useMutation({
    mutationFn: () =>
      authApi.replaceAssignments(user.id, {
        assignments,
        ...(adding ? { password } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.users });
      notifications.show({ color: 'green', message: 'Đã cập nhật vai trò.' });
      onClose();
    },
    onError: (error) => {
      setConfirming(false);
      form.setErrors(boundFieldErrors(error, ['assignments', 'password']));
    },
  });

  const submit = () => {
    form.clearErrors();
    if (hasIncompleteAssignment(assignments)) {
      form.setFieldError('assignments', 'Chọn chi nhánh cho mỗi vai trò');
      return;
    }
    if (adding && password === '') {
      form.setFieldError('password', 'Thêm quản trị viên phải đặt mật khẩu');
      return;
    }
    if (removing) {
      setConfirming(true);
      return;
    }
    save.mutate();
  };

  return (
    <Modal opened onClose={onClose} title={`Vai trò của ${user.email}`} centered size="lg">
      <ErrorAlert error={save.error} boundFields={['assignments', 'password']} />
      <Stack>
        <AssignmentsEditor
          value={assignments}
          onChange={(next) => form.setFieldValue('assignments', next)}
          roles={['ADMIN', 'MANAGER', 'STAFF']}
          branches={branches}
          error={typeof form.errors.assignments === 'string' ? form.errors.assignments : undefined}
        />
        {adding && (
          <PasswordInput
            label="Mật khẩu quản trị viên"
            description="Tối thiểu 12 ký tự."
            autoComplete="new-password"
            withAsterisk
            {...form.getInputProps('password')}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Lưu
          </Button>
        </Group>
      </Stack>
      <ConfirmDialog
        opened={confirming}
        title="Bớt vai trò"
        confirmLabel="Bớt vai trò"
        loading={save.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => save.mutate()}
      >
        Người này sẽ bị đăng xuất khỏi mọi thiết bị để nhận vai trò mới.
        {removesAdmin && ' Họ không còn là quản trị viên và mật khẩu của họ sẽ bị xoá.'}
      </ConfirmDialog>
    </Modal>
  );
}

// ---------------------------------------------------------------- Đặt lại mật khẩu (chỉ ADMIN)

/** Đặt lại mật khẩu của ADMIN khác. Người đó bị đăng xuất khỏi mọi thiết bị. Tự đổi dùng "Đổi mật khẩu". */
export function ResetPasswordModal({ user, onClose }: { user: User; onClose(): void }) {
  const form = useForm({
    initialValues: { newPassword: '', confirm: '' },
    validate: {
      newPassword: (value) => (value === '' ? 'Nhập mật khẩu mới' : null),
      confirm: (value, values) =>
        value !== values.newPassword ? 'Mật khẩu nhập lại không khớp' : null,
    },
  });
  const reset = useMutation({
    mutationFn: (newPassword: string) => authApi.resetPassword(user.id, { newPassword }),
    onSuccess: () => {
      notifications.show({
        color: 'green',
        message: 'Đã đặt lại mật khẩu. Người này bị đăng xuất khỏi mọi thiết bị.',
      });
      onClose();
    },
  });

  return (
    <Modal opened onClose={onClose} title={`Đặt lại mật khẩu cho ${user.email}`} centered>
      <form onSubmit={form.onSubmit((values) => reset.mutate(values.newPassword))}>
        <ErrorAlert error={reset.error} />
        <Stack>
          <Text size="sm" c="dimmed">
            Mật khẩu mới tối thiểu 12 ký tự. Hãy báo mật khẩu cho người đó qua kênh an toàn.
          </Text>
          <PasswordInput
            label="Mật khẩu mới"
            autoComplete="new-password"
            {...form.getInputProps('newPassword')}
          />
          <PasswordInput
            label="Nhập lại mật khẩu"
            autoComplete="new-password"
            {...form.getInputProps('confirm')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" color="red" loading={reset.isPending}>
              Đặt lại
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
