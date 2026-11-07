import {
  Alert,
  Anchor,
  Button,
  Center,
  Collapse,
  Divider,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { describeError } from '../api/messages.ts';
import { GoogleButton } from '../auth/google-button.tsx';
import { useSession } from '../auth/session-context.tsx';

/** Trang mà người dùng đang xem khi bị đưa về đây (do `RequireAuth` ghi vào `state.from`). */
function returnTarget(state: unknown): string {
  const from = (state as { from?: { pathname?: string; search?: string } } | null)?.from;
  return from?.pathname === undefined ? '/' : `${from.pathname}${from.search ?? ''}`;
}

export function LoginPage() {
  const { status, loginWithGoogle, loginWithPassword } = useSession();
  const location = useLocation();
  const [adminOpen, { toggle }] = useDisclosure(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm({
    initialValues: { email: '', password: '' },
    validate: {
      email: (value) => (value.trim() === '' ? 'Nhập email' : null),
      password: (value) => (value === '' ? 'Nhập mật khẩu' : null),
    },
  });

  if (status === 'authenticated') {
    return <Navigate to={returnTarget(location.state)} replace />;
  }

  const attempt = async (login: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await login();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" radius="md" w={380} maw="100%">
        <Stack>
          <Title order={2} ta="center">
            Đăng nhập
          </Title>
          <Text c="dimmed" size="sm" ta="center">
            Hệ thống quản lý chuỗi cửa hàng trang sức
          </Text>
          {error !== null && <Alert color="red">{error}</Alert>}
          {status === 'loading' ? null : (
            <GoogleButton
              onCredential={(credential) => void attempt(() => loginWithGoogle(credential))}
            />
          )}
          <Divider label="hoặc" />
          <Anchor component="button" type="button" size="sm" ta="center" onClick={toggle}>
            Đăng nhập quản trị (email và mật khẩu)
          </Anchor>
          <Collapse expanded={adminOpen}>
            <form
              onSubmit={form.onSubmit((values) =>
                attempt(() => loginWithPassword(values.email.trim(), values.password)),
              )}
            >
              <Stack>
                <TextInput
                  label="Email"
                  type="email"
                  autoComplete="username"
                  {...form.getInputProps('email')}
                />
                <PasswordInput
                  label="Mật khẩu"
                  autoComplete="current-password"
                  {...form.getInputProps('password')}
                />
                <Button type="submit" loading={busy}>
                  Đăng nhập
                </Button>
              </Stack>
            </form>
          </Collapse>
        </Stack>
      </Paper>
    </Center>
  );
}
