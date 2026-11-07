import { Button, Card, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation } from '@tanstack/react-query';
import { isApiError } from '../api/api-error.ts';
import { authApi } from '../api/endpoints.ts';
import { describeError } from '../api/messages.ts';
import { ErrorAlert } from '../components/error-alert.tsx';

/** Đổi mật khẩu của chính mình (chỉ ADMIN). Các thiết bị khác bị đăng xuất, thiết bị này giữ nguyên. */
export function ChangePasswordPage() {
  const form = useForm({
    initialValues: { currentPassword: '', newPassword: '', confirm: '' },
    validate: {
      currentPassword: (value) => (value === '' ? 'Nhập mật khẩu hiện tại' : null),
      newPassword: (value, values) =>
        value === ''
          ? 'Nhập mật khẩu mới'
          : value === values.currentPassword
            ? 'Mật khẩu mới phải khác mật khẩu cũ'
            : null,
      confirm: (value, values) =>
        value !== values.newPassword ? 'Mật khẩu nhập lại không khớp' : null,
    },
  });

  const change = useMutation({
    mutationFn: (values: { currentPassword: string; newPassword: string }) =>
      authApi.changePassword(values),
    onSuccess: () => {
      form.reset();
      notifications.show({
        color: 'green',
        message: 'Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.',
      });
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'INVALID_CREDENTIALS') {
        form.setFieldError('currentPassword', 'Mật khẩu hiện tại không đúng');
      } else if (isApiError(error) && error.code === 'PASSWORD_TOO_WEAK') {
        form.setFieldError('newPassword', describeError(error));
      }
    },
  });

  const bound =
    isApiError(change.error) &&
    (change.error.code === 'INVALID_CREDENTIALS' || change.error.code === 'PASSWORD_TOO_WEAK');

  return (
    <Stack maw={420}>
      <Title order={2}>Đổi mật khẩu</Title>
      <Card withBorder>
        <form
          onSubmit={form.onSubmit(({ currentPassword, newPassword }) =>
            change.mutate({ currentPassword, newPassword }),
          )}
        >
          {!bound && <ErrorAlert error={change.error} />}
          <Stack>
            <Text size="sm" c="dimmed">
              Mật khẩu mới tối thiểu 12 ký tự.
            </Text>
            <PasswordInput
              label="Mật khẩu hiện tại"
              autoComplete="current-password"
              {...form.getInputProps('currentPassword')}
            />
            <PasswordInput
              label="Mật khẩu mới"
              autoComplete="new-password"
              {...form.getInputProps('newPassword')}
            />
            <PasswordInput
              label="Nhập lại mật khẩu mới"
              autoComplete="new-password"
              {...form.getInputProps('confirm')}
            />
            <Button type="submit" loading={change.isPending}>
              Đổi mật khẩu
            </Button>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
