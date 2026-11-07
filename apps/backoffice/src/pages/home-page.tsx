import { Badge, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useBranchLabel } from '../api/queries.ts';
import { useActiveBranch } from '../auth/active-branch.tsx';
import { ROLE_LABELS } from '../auth/permissions.ts';
import { useSession } from '../auth/session-context.tsx';

export function HomePage() {
  const { me } = useSession();
  const { activeBranchId } = useActiveBranch();
  const branchLabel = useBranchLabel();
  if (me === undefined) {
    return null;
  }
  return (
    <Stack>
      <Title order={2}>Trang chủ</Title>
      <Card withBorder>
        <Title order={4} mb="sm">
          Tài khoản
        </Title>
        <Stack gap={4}>
          <Text>
            <b>Họ tên:</b> {me.fullName}
          </Text>
          <Text>
            <b>Email:</b> {me.email}
          </Text>
          <Group gap="xs">
            <Text>
              <b>Đăng nhập Google:</b>
            </Text>
            <Badge color={me.googleLinked ? 'green' : 'gray'}>
              {me.googleLinked ? 'Đã liên kết' : 'Chưa liên kết'}
            </Badge>
          </Group>
          {activeBranchId !== null && (
            <Text>
              <b>Chi nhánh đang làm việc:</b> {branchLabel(activeBranchId)}
            </Text>
          )}
        </Stack>
      </Card>
      <Card withBorder>
        <Title order={4} mb="sm">
          Vai trò
        </Title>
        {me.branches.length === 0 ? (
          <Text c="dimmed">Chưa có vai trò nào đang hiệu lực.</Text>
        ) : (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Phạm vi</Table.Th>
                <Table.Th>Vai trò</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {me.branches.map(({ branchId, role }) => (
                <Table.Tr key={`${role}:${branchId}`}>
                  <Table.Td>{branchLabel(branchId)}</Table.Td>
                  <Table.Td>{ROLE_LABELS[role]}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}
