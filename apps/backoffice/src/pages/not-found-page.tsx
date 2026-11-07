import { Button, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <Stack align="center" mt="xl">
      <Title order={2}>Không tìm thấy trang</Title>
      <Text c="dimmed">Đường dẫn này không tồn tại.</Text>
      <Button component={Link} to="/" variant="light">
        Về trang chủ
      </Button>
    </Stack>
  );
}
