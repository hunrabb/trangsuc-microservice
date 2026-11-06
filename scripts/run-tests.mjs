#!/usr/bin/env node
// Chạy test của một package: node ../../scripts/run-tests.mjs "src/**/*.test.ts"
// Khác `node --test`: THẤT BẠI khi số test chạy được bằng 0 (sai đường dẫn, glob bị bỏ qua, mọi test bị skip).
// Đếm bằng `test:summary` theo từng file: `test:pass` tính cả file rỗng (là một "test") và test bị skip.
import { globSync } from 'node:fs';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const patterns = process.argv.slice(2);
const files = patterns.flatMap((pattern) => globSync(pattern)).sort();

if (files.length === 0) {
  console.error(`LỖI: không tìm thấy file test nào khớp ${patterns.join(' ')}`);
  process.exit(1);
}

let passed = 0;
let failed = 0;

const stream = run({
  files,
  concurrency: true,
  execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'],
});

stream.on('test:summary', (event) => {
  if (event.file !== undefined) {
    passed += event.counts.passed;
  }
});
stream.on('test:fail', () => {
  failed += 1;
});
stream.on('end', () => {
  if (failed === 0 && passed === 0) {
    console.error(`LỖI: 0 test chạy được trong ${files.length} file: ${files.join(', ')}`);
    process.exitCode = 1;
  } else if (failed > 0) {
    process.exitCode = 1;
  }
});

stream.compose(spec).pipe(process.stdout);
