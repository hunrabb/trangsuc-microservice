import { Button, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router';

/** Hiện khi vào đường dẫn mà vai trò hiện tại không được phép. Không tải dữ liệu nào. */
export function ForbiddenPage() {
  return (
    <Stack align="center" mt="xl">
      <Title order={2}>Không có quyền</Title>
      <Text c="dimmed">Bạn không có quyền xem trang này.</Text>
      <Button component={Link} to="/" variant="light">
        Về trang chủ
      </Button>
    </Stack>
  );
}
