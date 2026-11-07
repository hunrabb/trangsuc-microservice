import { Button, Group, Modal, Text } from '@mantine/core';
import type { ReactNode } from 'react';

/** Hộp xác nhận cho thao tác nguy hiểm (khoá, gỡ Google, bớt vai trò, ngừng hoạt động). */
export function ConfirmDialog({
  opened,
  title,
  children,
  confirmLabel,
  confirmColor = 'red',
  loading = false,
  onConfirm,
  onCancel,
}: {
  opened: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Màu nút xác nhận: đỏ cho thao tác nguy hiểm (mặc định), màu chính cho thao tác thường. */
  confirmColor?: string;
  loading?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <Modal opened={opened} onClose={onCancel} title={title} centered>
      <Text size="sm">{children}</Text>
      <Group justify="flex-end" mt="lg">
        <Button variant="default" onClick={onCancel} disabled={loading}>
          Huỷ
        </Button>
        <Button color={confirmColor} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </Group>
    </Modal>
  );
}
