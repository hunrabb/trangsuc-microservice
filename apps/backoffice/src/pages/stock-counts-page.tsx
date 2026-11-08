import { Alert, Button, Card, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { isApiError } from '../api/api-error.ts';
import { describeError } from '../api/messages.ts';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { hasRoleAtBranch } from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';
import { BranchSwitcher, useWorkingBranch } from '../inventory/working-branch.tsx';

/**
 * Phiên kiểm kê gần nhất mà trình duyệt này đã mở, theo từng chi nhánh. Server chưa có danh sách phiên, nên đây là
 * cách quay lại phiên đang dở sau khi tải lại trang. Chỉ là id phiên (không phải bí mật); đọc ghi đều có thể lỗi.
 */
const lastSessionKey = (branchId: string) => `backoffice.lastStockCount.${branchId}`;

export const readLastStockCount = (branchId: string): string | null => {
  try {
    return window.localStorage.getItem(lastSessionKey(branchId));
  } catch {
    return null;
  }
};

export const rememberLastStockCount = (branchId: string, stockCountId: string): void => {
  try {
    window.localStorage.setItem(lastSessionKey(branchId), stockCountId);
  } catch {
    // không nhớ được thì phải mở lại phiên từ danh sách
  }
};

/**
 * Điểm vào của kiểm kê: MANAGER mở phiên mới cho chi nhánh đang làm việc, mọi người có thể tiếp tục phiên gần nhất.
 * Kho đang có phiên chưa đóng thì server trả `INVALID_STATE`; trang giải thích và gợi ý tiếp tục phiên gần nhất.
 */
export function StockCountsPage() {
  const { me } = useSession();
  const { branchId } = useWorkingBranch();
  const navigate = useNavigate();

  const open = useMutation({
    mutationFn: () => inventoryApi.createStockCount(branchId ?? ''),
    onSuccess: (summary) => {
      rememberLastStockCount(summary.branchId, summary.id);
      navigate(`/kiem-ke/${summary.id}`);
    },
    onError: (error) => {
      const sessionAlreadyOpen = isApiError(error) && error.code === 'INVALID_STATE';
      notifications.show({
        color: 'red',
        message: sessionAlreadyOpen
          ? 'Kho này đang có phiên kiểm kê chưa đóng. Hãy tiếp tục phiên đó rồi đóng lại.'
          : describeError(error),
      });
    },
  });

  const canOpen = me !== undefined && hasRoleAtBranch(me.branches, branchId, ['MANAGER']);
  const lastSessionId = branchId === null ? null : readLastStockCount(branchId);

  return (
    <Stack>
      <Title order={2}>Kiểm kê</Title>
      <BranchSwitcher />
      <Card withBorder radius="md" padding="lg">
        <Stack>
          <Text>
            Mở phiên để chụp danh sách chiếc đang có trong kho, rồi quét từng mã tem. Khi đóng
            phiên, chiếc nào không quét được sẽ được ghi là thiếu; mã quét được mà không thuộc kho
            được liệt kê là thừa. Kiểm kê không tự đổi trạng thái hàng.
          </Text>
          {canOpen ? (
            <Button
              w="fit-content"
              loading={open.isPending}
              disabled={branchId === null}
              onClick={() => open.mutate()}
            >
              Mở phiên kiểm kê mới
            </Button>
          ) : (
            <Alert color="blue">
              Chỉ quản lý chi nhánh mới mở được phiên mới. Bạn vẫn quét được phiên đang mở.
            </Alert>
          )}
          {lastSessionId !== null && (
            <Button
              w="fit-content"
              variant="default"
              onClick={() => navigate(`/kiem-ke/${lastSessionId}`)}
            >
              Tiếp tục phiên gần nhất
            </Button>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
