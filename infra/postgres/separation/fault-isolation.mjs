// Controlled stop/start on only the labelled acceptance PostgreSQL containers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertTestTarget } from './assert-test-target.mjs';

const root = resolve(import.meta.dirname, '../../..');
const address = spawnSync('ip', ['-4', '-o', 'addr', 'show', 'dev', 'eth0'], { encoding: 'utf8' });
const hostIp = address.stdout.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)\//)?.[1];
assert.ok(hostIp, 'Cannot determine WSL eth0 IPv4 for acceptance overlay');
process.env.ACCEPTANCE_HOST_IP = hostIp;
const services = ['auth', 'inventory', 'sales', 'report'];
const ports = { auth: 15433, inventory: 15434, sales: 15435, report: 15436 };
const appPorts = { inventory: 13002, sales: 13003, report: 13004 };
const composeArgs = ['compose', '--env-file', resolve(root, '.env'), '-p', 'jewelry-db-separation-test',
  '-f', resolve(root, 'infra/postgres/separation/compose.test.yml'),
  '-f', resolve(root, 'infra/postgres/separation/compose.migrate-test.yml'),
  '-f', resolve(root, 'infra/postgres/separation/compose.acceptance.yml'),
  '-f', resolve(root, 'infra/postgres/separation/compose.hybrid.yml')];
const run = (args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 45_000 });
  if (result.status !== 0) throw new Error(`${args[0]} ${args[1]} failed: ${result.stderr.slice(-500)}`);
  return result.stdout;
};
const inspect = (name) => JSON.parse(run(['inspect', name]))[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready(service) {
  if (service === 'auth') {
    const code = run(['exec', 'jewelry-db-separation-test-auth-1', 'node', '-e',
      "fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(3000)}).then(r=>console.log(r.status)).catch(()=>console.log(0))"]);
    return Number(code.trim());
  }
  try {
    const response = await fetch(`http://127.0.0.1:${appPorts[service]}/health/ready`, { signal: AbortSignal.timeout(3000) });
    return response.status;
  } catch { return 0; }
}

for (const service of services) assertTestTarget(service, ports[service]);
assert.equal(inspect('jewelry-db-separation-test-gateway-1').Config.Labels['com.docker.compose.project'], 'jewelry-db-separation-test');
for (const service of services) {
  const db = `${service}-postgres`;
  const name = `jewelry-db-separation-test-${db}-1`;
  let stopped = false;
  try {
    assert.equal(await ready(service), 200, `${service} readiness before outage`);
    run([...composeArgs, 'stop', '-t', '10', db]);
    stopped = true;
    assert.equal(inspect(name).State.Running, false);
    await sleep(1500);
    for (const other of services.filter((item) => item !== service)) {
      const state = inspect(`jewelry-db-separation-test-${other}-postgres-1`).State;
      assert.equal(state.Running, true, `${other} DB must remain running`);
      assert.equal(state.Health.Status, 'healthy', `${other} DB must remain healthy`);
    }
    const unavailable = await ready(service);
    assert.notEqual(unavailable, 200, `${service} must not report ready without DB`);
    const gateway = await fetch('http://127.0.0.1:13000/api/ping', { signal: AbortSignal.timeout(3000) });
    assert.equal(gateway.status, 200);
    console.log(`PASS ${service} DB stopped: ${service} readiness=${unavailable}, three other DBs healthy, Gateway=200`);
  } finally {
    if (stopped) {
      run([...composeArgs, 'start', db]);
      let recovered = false;
      for (let i = 0; i < 30; i++) {
        if (inspect(name).State.Health?.Status === 'healthy' && await ready(service) === 200) {
          recovered = true;
          break;
        }
        await sleep(1500);
      }
      assert.equal(recovered, true, `${service} DB and service failed to recover`);
      console.log(`PASS ${service} DB and service recovered`);
    }
  }
}
console.log('RESULT PASS 4/4 controlled DB fault-isolation and recovery cases');
