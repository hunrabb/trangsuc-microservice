import { Alert, Button, Group, Paper, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/instance.ts';
import { authApi } from '../api/endpoints.ts';
import { loadReportBranchOptions } from '../api/report-branches.ts';
import { reportApi } from '../api/report-endpoints.ts';
import { fetchReportExcel, saveReportExcel } from '../api/report-download.ts';
import type { ExcelReport } from '../api/report-types.ts';
import { canViewReports, isAdmin } from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';
import { ErrorAlert } from '../components/error-alert.tsx';
import { ReportPanels } from './report-panels.tsx';
import { canExportReport, reportBranches, reportFilterInput, vietnamToday } from './report-view.ts';

export function ReportsPage() {
  const { me } = useSession();
  const roles = me?.branches ?? [];
  const scope = JSON.stringify(roles.map(({ role, branchId }) => [role, branchId]));
  const branchQuery = useQuery({
    queryKey: ['report-branches', me?.id, scope],
    queryFn: () => loadReportBranchOptions(authApi.listBranches),
    enabled: isAdmin(roles),
  });
  const branchLabel = (id: string | null) =>
    id === null
      ? 'Toàn hệ thống'
      : (me?.branches.find((entry) => entry.branchId === id)?.branchName ??
        branchQuery.data?.find((entry) => entry.id === id)?.name ??
        'Chi nhánh khác');
  const branches = reportBranches(roles, branchQuery.data ?? []);
  const [from, setFrom] = useState(() => `${vietnamToday().slice(0, 7)}-01`);
  const [to, setTo] = useState(vietnamToday);
  const [branchInput, setBranch] = useState<string | null>(null);
  const branch = branchInput ?? branches[0]?.value ?? '';
  const { filter, error } = reportFilterInput(roles, from, to, branch);
  const allowed = canViewReports(roles);
  // Scope/user trong cache key để thay đổi quyền không hiện lại dữ liệu chi nhánh cũ.
  const key = ['reports', me?.id, scope, from, to, branch];
  const daily = useQuery({
    queryKey: [...key, 'daily'],
    queryFn: () => reportApi.daily(filter!),
    enabled: allowed && !!filter,
  });
  const top = useQuery({
    queryKey: [...key, 'top'],
    queryFn: () => reportApi.topProducts(filter!),
    enabled: allowed && !!filter,
  });
  const stock = useQuery({
    queryKey: [...key, 'stock'],
    queryFn: () => reportApi.stock(filter!),
    enabled: allowed && !!filter,
  });
  const download = useMutation({
    mutationFn: async (kind: ExcelReport) => {
      if (!filter || !canExportReport(filter)) throw new Error('Bộ lọc Excel không hợp lệ');
      return fetchReportExcel(api, kind, filter);
    },
    onSuccess: saveReportExcel,
  });
  const updateFilter = (update: () => void) => {
    download.reset();
    update();
  };
  if (!allowed) return <Alert color="red">Bạn không có quyền xem báo cáo.</Alert>;
  return (
    <Stack>
      <Title order={2}>Báo cáo</Title>
      <Text size="sm" c="dimmed">
        Doanh thu POS và tồn kho theo ngày Việt Nam. Số liệu cập nhật sau khi hệ thống xử lý giao
        dịch và bản chốt kho.
      </Text>
      <Paper withBorder p="md">
        <Group align="end">
          <TextInput
            type="date"
            label="Từ ngày"
            value={from}
            onChange={(event) => updateFilter(() => setFrom(event.currentTarget.value))}
          />
          <TextInput
            type="date"
            label="Đến ngày"
            value={to}
            onChange={(event) => updateFilter(() => setTo(event.currentTarget.value))}
          />
          <Select
            label="Chi nhánh báo cáo"
            data={branches}
            value={branches.some((item) => item.value === branch) ? branch : null}
            onChange={(value) => updateFilter(() => setBranch(value))}
            allowDeselect={false}
            searchable
            style={{ flexGrow: 1, minWidth: 220 }}
          />
          <Button
            variant="light"
            disabled={!filter}
            onClick={() => {
              void daily.refetch();
              void top.refetch();
              void stock.refetch();
              if (branchQuery.isError) void branchQuery.refetch();
            }}
          >
            Tải lại
          </Button>
        </Group>
      </Paper>
      <ErrorAlert error={branchQuery.error} />
      {error ? (
        <Alert color="yellow">{error}</Alert>
      ) : (
        <>
          {!canExportReport(filter) && (
            <Alert color="blue">
              Excel hỗ trợ tối đa 31 ngày mỗi lần tải. Hãy thu hẹp khoảng ngày để xuất file.
            </Alert>
          )}
          <ErrorAlert error={download.error} />
          <ReportPanels
            roles={roles}
            daily={{
              data: daily.data,
              loading: daily.isPending,
              error: daily.error,
              retry: () => {
                void daily.refetch();
              },
            }}
            top={{
              data: top.data,
              loading: top.isPending,
              error: top.error,
              retry: () => {
                void top.refetch();
              },
            }}
            stock={{
              data: stock.data,
              loading: stock.isPending,
              error: stock.error,
              retry: () => {
                void stock.refetch();
              },
            }}
            branchLabel={branchLabel}
            canExport={canExportReport(filter)}
            downloading={download.isPending ? download.variables : null}
            onDownload={(kind) => download.mutate(kind)}
          />
        </>
      )}
    </Stack>
  );
}
