import {
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { BuybackDetail, CreateBuyback } from '@jewelry/contracts';
import { describeError } from '../api/messages.ts';
import { useSession } from '../auth/session-context.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { ErrorAlert } from '../components/error-alert.tsx';
import { BranchSwitcher, useWorkingBranch } from '../inventory/working-branch.tsx';
import { formatDateTime, formatWeight } from '../inventory/format.ts';
import { buybackApi } from './api.ts';
import { AppraisalPanel } from './appraisal-panel.tsx';
import { IntakeForm } from './intake-form.tsx';
import { QuotePanel } from './quote-panel.tsx';
import { AUDIT_ACTION, fieldsFromDetail, intakeActions, STATUS } from './model.ts';
import { SettlementPanel } from './settlement-panel.tsx';

export function BuybackDetailPage() {
  const { buybackId = '' } = useParams();
  const { branchId } = useWorkingBranch();
  const { me } = useSession();
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const detail = useQuery({
    queryKey: ['buybacks', 'detail', branchId, buybackId],
    queryFn: () => buybackApi.get(branchId!, buybackId),
    enabled: branchId !== null && buybackId !== '',
  });
  const store = async (result: BuybackDetail) => {
    cache.setQueryData(['buybacks', 'detail', branchId, buybackId], result);
    await cache.invalidateQueries({ queryKey: ['buybacks'] });
  };
  const action = useMutation({
    mutationFn: async (
      command:
        | { type: 'update'; body: CreateBuyback; version: number }
        | { type: 'submit' | 'cancel'; version: number; reason?: string },
    ) => {
      if (command.type === 'update')
        return buybackApi.update(branchId!, buybackId, {
          ...command.body,
          version: command.version,
        });
      if (command.type === 'submit')
        return buybackApi.submit(branchId!, buybackId, command.version);
      return buybackApi.cancel(branchId!, buybackId, command.version, command.reason!);
    },
    onSuccess: async (result, command) => {
      await store(result);
      setEditing(false);
      setSubmitOpen(false);
      setCancelOpen(false);
      setReason('');
      notifications.show({
        color: 'green',
        message:
          command.type === 'update'
            ? 'Đã lưu phiếu.'
            : command.type === 'submit'
              ? 'Đã gửi kiểm định.'
              : 'Đã huỷ phiếu.',
      });
    },
    onError: (error) => notifications.show({ color: 'red', message: describeError(error) }),
  });
  const current = detail.data;
  const allowed = current ? intakeActions(me, current) : null;
  return (
    <Stack>
      <Group justify="space-between">
        <Stack gap={0}>
          <Title order={2}>Phiếu thu mua {current?.code ?? ''}</Title>
          <Text component={Link} to="/thu-mua" size="sm" c="indigo">
            ← Danh sách phiếu
          </Text>
          <Text component="a" href="#thanh-toan" size="sm" c="indigo">
            Đến thanh toán / đổi trang sức ↓
          </Text>
        </Stack>
        {current && (
          <Badge size="lg" color={STATUS[current.status].color}>
            {STATUS[current.status].label}
          </Badge>
        )}
      </Group>
      <BranchSwitcher />
      {detail.isPending && (
        <Stack>
          <Skeleton h={100} />
          <Skeleton h={180} />
          <Skeleton h={120} />
        </Stack>
      )}
      {detail.isError && <ErrorAlert error={detail.error} onReload={() => void detail.refetch()} />}
      {current && (
        <>
          <Paper withBorder p="md">
            <Stack gap="xs">
              <Text>
                Khách: <b>{current.customerName}</b> · {current.customerPhone}
              </Text>
              <Text>Chi nhánh: {current.branchId}</Text>
              <Text>Người tiếp nhận: {current.createdBy}</Text>
              <Text>
                Tiếp nhận lúc: {formatDateTime(current.receivedAt)} · Phiên bản: {current.version}
              </Text>
              {current.notes && <Text>Ghi chú: {current.notes}</Text>}
              {current.cancellationReason && (
                <Text c="red">Lý do huỷ: {current.cancellationReason}</Text>
              )}
            </Stack>
          </Paper>
          <Group>
            {allowed?.edit && (
              <Button variant="light" onClick={() => setEditing((value) => !value)}>
                {editing ? 'Đóng chỉnh sửa' : 'Chỉnh sửa phiếu'}
              </Button>
            )}
            {allowed?.submit && <Button onClick={() => setSubmitOpen(true)}>Gửi kiểm định</Button>}
            {allowed?.cancel && (
              <Button color="red" variant="light" onClick={() => setCancelOpen(true)}>
                Huỷ phiếu
              </Button>
            )}
          </Group>
          {editing && allowed?.edit && (
            <IntakeForm
              key={current.version}
              initial={fieldsFromDetail(current)}
              submitLabel="Lưu thay đổi"
              busy={action.isPending}
              error={action.error}
              onReload={() => void detail.refetch()}
              onSubmit={async (body) => {
                await action.mutateAsync({ type: 'update', body, version: current.version });
              }}
            />
          )}
          <Paper withBorder p="md">
            <Title order={4} mb="sm">
              Danh sách món
            </Title>
            <Table.ScrollContainer minWidth={620}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Món</Table.Th>
                    <Table.Th>Loại</Table.Th>
                    <Table.Th>Tem tham chiếu</Table.Th>
                    <Table.Th>Khách khai</Table.Th>
                    <Table.Th>Đo ban đầu</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {current.items.map((item) => (
                    <Table.Tr key={item.id}>
                      <Table.Td>
                        {item.position}. {item.description}
                        <Text size="xs" c="dimmed">
                          {item.condition}
                        </Text>
                      </Table.Td>
                      <Table.Td>{item.assetKind}</Table.Td>
                      <Table.Td>{item.referenceTagCode ?? '—'}</Table.Td>
                      <Table.Td>
                        {item.declaredWeight ? formatWeight(item.declaredWeight) : '—'}
                      </Table.Td>
                      <Table.Td>
                        {item.initialMeasuredWeight
                          ? formatWeight(item.initialMeasuredWeight)
                          : '—'}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
          <AppraisalPanel
            branchId={current.branchId}
            detail={current}
            allowed={Boolean(allowed?.appraise)}
          />
          <QuotePanel
            branchId={current.branchId}
            detail={current}
            canQuote={Boolean(allowed?.quote)}
            canDecide={Boolean(allowed?.decide)}
          />
          <SettlementPanel key={`${current.branchId}:${current.id}`} detail={current} />
          <Paper withBorder p="md">
            <Title order={4} mb="sm">
              Lịch sử thao tác
            </Title>
            {current.latestAudit.length === 0 ? (
              <Text c="dimmed">Chưa có lịch sử.</Text>
            ) : (
              <Table.ScrollContainer minWidth={580}>
                <Table>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Thời gian</Table.Th>
                      <Table.Th>Thao tác</Table.Th>
                      <Table.Th>Người thực hiện</Table.Th>
                      <Table.Th>Phiên bản</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {current.latestAudit.map((row) => (
                      <Table.Tr key={row.id}>
                        <Table.Td>{formatDateTime(row.createdAt)}</Table.Td>
                        <Table.Td>{AUDIT_ACTION[row.action]}</Table.Td>
                        <Table.Td>{row.actorId}</Table.Td>
                        <Table.Td>{row.toVersion}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Paper>
          <ConfirmDialog
            opened={submitOpen}
            title="Gửi kiểm định"
            confirmLabel="Gửi kiểm định"
            confirmColor="indigo"
            loading={action.isPending}
            onCancel={() => setSubmitOpen(false)}
            onConfirm={() => action.mutate({ type: 'submit', version: current.version })}
          >
            Sau khi gửi, phiếu nháp sẽ bị khóa chỉnh sửa.
          </ConfirmDialog>
          <Modal
            opened={cancelOpen}
            onClose={() => setCancelOpen(false)}
            title="Huỷ phiếu thu mua"
            centered
          >
            <Stack>
              <Textarea
                label="Lý do huỷ (5–500 ký tự)"
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.currentTarget.value)}
              />
              <Group justify="end">
                <Button variant="default" onClick={() => setCancelOpen(false)}>
                  Đóng
                </Button>
                <Button
                  color="red"
                  disabled={reason.trim().length < 5}
                  loading={action.isPending}
                  onClick={() =>
                    action.mutate({
                      type: 'cancel',
                      version: current.version,
                      reason: reason.trim(),
                    })
                  }
                >
                  Xác nhận huỷ
                </Button>
              </Group>
            </Stack>
          </Modal>
        </>
      )}
    </Stack>
  );
}
