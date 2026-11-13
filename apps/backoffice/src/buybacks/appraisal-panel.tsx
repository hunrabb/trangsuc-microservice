import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { AppraisalInput, BuybackDetail, Metal } from '@jewelry/contracts';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { describeError } from '../api/messages.ts';
import { ErrorAlert } from '../components/error-alert.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { formatDateTime, formatWeight } from '../inventory/format.ts';
import { buybackApi, type BuybackAppraisals } from './api.ts';
import { validAppraisal } from './model.ts';

type Revision = BuybackAppraisals['items'][number];
type Values = Omit<AppraisalInput, 'version'>;

function AppraisalEditor({
  item,
  current,
  version,
  metals,
  branchId,
  intakeId,
}: {
  item: BuybackDetail['items'][number];
  current?: Revision;
  version: number;
  metals: Metal[];
  branchId: string;
  intakeId: string;
}) {
  const cache = useQueryClient();
  const [values, setValues] = useState<Values>(() => ({
    measuredWeight: current?.measuredWeight ?? item.initialMeasuredWeight ?? '',
    acceptedWeight: current?.acceptedWeight ?? '',
    metalId: current?.metalId ?? '',
    metalKind: current?.metalKind ?? (item.assetKind === 'SILVER' ? 'SILVER' : 'GOLD'),
    purityPerMille: current?.purityPerMille ?? '',
    condition: current?.condition ?? item.condition,
    notes: current?.notes ?? null,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const update = (patch: Partial<Values>) => {
    setValues((value) => ({ ...value, ...patch }));
    setErrors({});
  };
  const mutation = useMutation({
    mutationFn: async (body: AppraisalInput) => {
      const signature = JSON.stringify(body);
      if (pending.current?.signature !== signature)
        pending.current = { signature, key: crypto.randomUUID() };
      return buybackApi.appraise(branchId, intakeId, item.id, body, pending.current.key);
    },
    onSuccess: async () => {
      pending.current = null;
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['buybacks'] }),
        cache.invalidateQueries({ queryKey: ['buyback-appraisals', branchId, intakeId] }),
        cache.invalidateQueries({ queryKey: ['buyback-quotes', branchId, intakeId] }),
      ]);
      notifications.show({
        color: 'green',
        message: 'Đã ghi phiên bản kiểm định mới; báo giá cũ được làm mới.',
      });
    },
    onError: (error) => notifications.show({ color: 'red', message: describeError(error) }),
  });
  const save = () => {
    const body = { ...values, version };
    const next = validAppraisal(body);
    setErrors(next);
    if (Object.keys(next).length === 0) setConfirming(true);
  };
  const options = metals.filter(
    (metal) => metal.isActive && (item.assetKind === 'JEWELRY' || metal.kind === item.assetKind),
  );
  return (
    <Paper withBorder p="md">
      <Stack>
        <Group justify="space-between">
          <Title order={5}>
            Món {item.position}: {item.description}
          </Title>
          {current && <Badge color="blue">Lần kiểm định {current.intakeVersion}</Badge>}
        </Group>
        <Text size="sm" c="dimmed">
          Khách khai: {item.declaredWeight ? formatWeight(item.declaredWeight) : '—'} · Đo ban đầu:{' '}
          {item.initialMeasuredWeight ? formatWeight(item.initialMeasuredWeight) : '—'}
        </Text>
        {current && (
          <Text size="sm">
            Kiểm định bởi {current.appraisedBy} lúc {formatDateTime(current.appraisedAt)}.
          </Text>
        )}
        <ErrorAlert
          error={mutation.error}
          onReload={() => void cache.invalidateQueries({ queryKey: ['buybacks'] })}
        />
        {options.length === 0 && (
          <Alert color="yellow">Chưa có kim loại phù hợp đang hoạt động để kiểm định.</Alert>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="Trọng lượng thực tế (chỉ)"
            value={values.measuredWeight}
            error={errors.measuredWeight}
            onChange={(event) => update({ measuredWeight: event.currentTarget.value })}
          />
          <TextInput
            label="Trọng lượng chấp nhận (chỉ)"
            value={values.acceptedWeight}
            error={errors.acceptedWeight}
            onChange={(event) => update({ acceptedWeight: event.currentTarget.value })}
          />
          <Select
            label="Kim loại / tuổi"
            searchable
            data={options.map((metal) => ({
              value: metal.id,
              label: `${metal.code} · ${metal.name}`,
            }))}
            value={values.metalId || null}
            error={errors.metalId}
            onChange={(value) => {
              const metal = metals.find((entry) => entry.id === value);
              update({ metalId: value ?? '', ...(metal ? { metalKind: metal.kind } : {}) });
            }}
          />
          <TextInput
            label="Hàm lượng (phần nghìn)"
            value={values.purityPerMille}
            error={errors.purityPerMille}
            onChange={(event) => update({ purityPerMille: event.currentTarget.value })}
          />
        </SimpleGrid>
        <TextInput
          label="Tình trạng thực tế"
          value={values.condition}
          maxLength={1000}
          error={errors.condition}
          onChange={(event) => update({ condition: event.currentTarget.value })}
        />
        <Textarea
          label="Ghi chú kiểm định"
          value={values.notes ?? ''}
          maxLength={1000}
          error={errors.notes}
          onChange={(event) => update({ notes: event.currentTarget.value || null })}
        />
        <Group justify="end">
          <Button disabled={options.length === 0} loading={mutation.isPending} onClick={save}>
            {current ? 'Lưu phiên bản kiểm định mới' : 'Lưu kiểm định'}
          </Button>
        </Group>
        <ConfirmDialog
          opened={confirming}
          title="Xác nhận kiểm định"
          confirmLabel="Ghi kiểm định"
          confirmColor="indigo"
          loading={mutation.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            mutation.mutate({ ...values, version }, { onSuccess: () => setConfirming(false) })
          }
        >
          Kết quả sẽ tạo một phiên bản kiểm định mới và có thể thay thế báo giá chưa duyệt.
        </ConfirmDialog>
      </Stack>
    </Paper>
  );
}

export function AppraisalPanel({
  branchId,
  detail,
  allowed,
}: {
  branchId: string;
  detail: BuybackDetail;
  allowed: boolean;
}) {
  const appraisals = useQuery({
    queryKey: ['buyback-appraisals', branchId, detail.id],
    queryFn: () => buybackApi.appraisals(branchId, detail.id),
  });
  const metals = useQuery({
    queryKey: ['metals'],
    queryFn: inventoryApi.listMetals,
    enabled: allowed,
  });
  const rows = appraisals.data?.items ?? [];
  return (
    <Stack>
      <Title order={3}>Kiểm định</Title>
      <Text size="sm" c="dimmed">
        API hiện chỉ trả bản kiểm định mới nhất của từng món; các phiên bản cũ chưa có endpoint xem
        lại.
      </Text>
      {appraisals.isPending && <Skeleton h={100} />}
      {appraisals.isError && (
        <ErrorAlert error={appraisals.error} onReload={() => void appraisals.refetch()} />
      )}
      {metals.isError && <ErrorAlert error={metals.error} onReload={() => void metals.refetch()} />}
      {!allowed && rows.length === 0 && <Text c="dimmed">Chưa có kết quả kiểm định.</Text>}
      {!allowed &&
        rows.map((row) => (
          <Paper key={row.itemId} withBorder p="md">
            <Text fw={600}>
              Món {detail.items.find((item) => item.id === row.itemId)?.position}: {row.metalKind}
            </Text>
            <Text size="sm">
              Đo thực tế {formatWeight(row.measuredWeight)} · Chấp nhận{' '}
              {formatWeight(row.acceptedWeight)} · Hàm lượng {row.purityPerMille}‰
            </Text>
            <Text size="sm">
              Tình trạng: {row.condition}; người kiểm định: {row.appraisedBy}; phiên bản:{' '}
              {row.intakeVersion}.
            </Text>
          </Paper>
        ))}
      {allowed &&
        metals.data &&
        detail.items.map((item) => (
          <AppraisalEditor
            key={`${item.id}:${rows.find((row) => row.itemId === item.id)?.id ?? 'new'}`}
            item={item}
            current={rows.find((row) => row.itemId === item.id)}
            version={detail.version}
            metals={metals.data}
            branchId={branchId}
            intakeId={detail.id}
          />
        ))}
    </Stack>
  );
}
