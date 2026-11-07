#!/usr/bin/env node
// Chạy test của một package: node ../../scripts/run-tests.mjs "src/**/*.test.ts"
// Thất bại nếu không có test nào pass (glob sai, file rỗng hoặc toàn bộ test bị skip).
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Chạy từng file tuần tự để không dồn nhiều service/test worker lên máy ít RAM.
// Chạy file trực tiếp để các suite `node:test` trong TypeScript được đăng ký và đếm đúng trên Node 24.
// Giữ `--sequential` để không làm hỏng các caller cũ; mọi file hiện đều chạy tuần tự.
const args = process.argv.slice(2);
const patterns = args.filter((arg) => arg !== '--sequential');
const files = patterns.flatMap((pattern) => globSync(pattern)).sort();

if (files.length === 0) {
  console.error(`LỖI: không tìm thấy file test nào khớp ${patterns.join(' ')}`);
  process.exit(1);
}

let passed = 0;
let failed = 0;

for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', file],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);

  if (result.error !== undefined) {
    console.error(`Không chạy được ${file}: ${result.error.message}`);
    failed += 1;
    continue;
  }
  if (result.status !== 0) {
    failed += 1;
  }

  const summary = output.match(/ℹ pass (\d+)/);
  if (summary === null) {
    console.error(`Không đọc được số test trong kết quả của ${file}`);
    failed += 1;
  } else {
    passed += Number(summary[1]);
  }
}

if (failed > 0 || passed === 0) {
  if (passed === 0) {
    console.error(`LỖI: 0 test chạy được trong ${files.length} file: ${files.join(', ')}`);
  }
  process.exitCode = 1;
}
