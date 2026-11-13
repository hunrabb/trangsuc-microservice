import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/** Từ chối kết nối localhost nếu cổng không thuộc đúng container/volume test. */
export function assertTestTarget(service, port) {
  const name = `jewelry-db-separation-test-${service}-postgres-1`;
  const result = spawnSync('docker', ['inspect', name], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${name} không tồn tại hoặc không kiểm tra được`);
  const [container] = JSON.parse(result.stdout);
  assert.equal(container.Config.Labels['com.docker.compose.project'], 'jewelry-db-separation-test');
  assert.equal(container.Config.Labels['com.docker.compose.service'], `${service}-postgres`);
  assert.equal(container.State.Running, true);
  const bindings = container.NetworkSettings.Ports['5432/tcp'] ?? [];
  assert.ok(bindings.some((item) => item.HostIp === '127.0.0.1' && item.HostPort === String(port)));
  const data = container.Mounts.find((item) => item.Destination === '/var/lib/postgresql/data');
  assert.equal(data?.Name, `jewelry-db-separation-test_${service}_pg_data`);
}
