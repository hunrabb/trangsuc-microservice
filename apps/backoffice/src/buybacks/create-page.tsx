import { Alert, Button, Stack, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { CreateBuyback } from '@jewelry/contracts';
import { isApiError } from '../api/api-error.ts';
import { describeError } from '../api/messages.ts';
import { BranchSwitcher, useWorkingBranch } from '../inventory/working-branch.tsx';
import { buybackApi } from './api.ts';
import { IntakeForm } from './intake-form.tsx';

export function BuybackCreatePage() {
  const { branchId } = useWorkingBranch();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const pending = useRef<{ branchId: string; body: CreateBuyback; key: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const create = useMutation({
    mutationFn: async (body: CreateBuyback) => {
      // Lần gửi lại sau mất kết nối giữ nguyên body/key, không tạo phiếu khác.
      const command = pending.current ?? { branchId: branchId!, body, key: crypto.randomUUID() };
      pending.current = command;
      try {
        return await buybackApi.create(command.branchId, command.body, command.key);
      } catch (error) {
        if (isApiError(error) && error.status === 0) {
          try {
            return await buybackApi.byKey(command.branchId, command.key);
          } catch (lookupError) {
            if (!isApiError(lookupError) || lookupError.status !== 404) throw lookupError;
          }
        }
        throw error;
      }
    },
    onSuccess: async (detail) => {
      pending.current = null;
      setUncertain(false);
      await cache.invalidateQueries({ queryKey: ['buybacks'] });
      notifications.show({ color: 'green', message: 'Đã tạo phiếu tiếp nhận.' });
      navigate(`/thu-mua/${detail.id}`);
    },
    onError: (error) => {
      const ambiguous = !isApiError(error) || error.status === 0 || error.status >= 500;
      if (ambiguous) setUncertain(true);
      else pending.current = null;
    },
  });
  return (
    <Stack>
      <Title order={2}>Tiếp nhận vàng cũ</Title>
      <BranchSwitcher />
      {uncertain && pending.current && (
        <Alert color="yellow" title="Chưa rõ kết quả gửi phiếu">
          Giữ nguyên nội dung và khóa yêu cầu ban đầu. Chọn lại chi nhánh {pending.current.branchId}{' '}
          rồi kiểm tra/gửi lại cùng yêu cầu.
          <Button
            mt="sm"
            size="xs"
            disabled={branchId !== pending.current.branchId}
            loading={create.isPending}
            onClick={() => pending.current && create.mutate(pending.current.body)}
          >
            Kiểm tra và gửi lại
          </Button>
        </Alert>
      )}
      {branchId === null ? (
        <Alert color="yellow">Chọn chi nhánh trước khi tạo phiếu.</Alert>
      ) : uncertain ? null : (
        <IntakeForm
          key={branchId}
          submitLabel="Tạo phiếu"
          busy={create.isPending}
          error={create.error}
          onSubmit={async (body) => {
            try {
              await create.mutateAsync(body);
            } catch (error) {
              notifications.show({ color: 'red', message: describeError(error) });
            }
          }}
        />
      )}
    </Stack>
  );
}
