#!/usr/bin/env node
// Sinh phần `components/schemas` của docs/api/auth.openapi.yaml từ schema zod trong libs/contracts.
//   pnpm openapi:generate           ghi vào file
//   node scripts/openapi-generate.mjs --check   chỉ so sánh, lệch thì thoát mã 1
// Phần `paths` viết tay; không sửa tay từ dòng `schemas:` trở xuống.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import contracts from '../libs/contracts/dist/index.js';

const SPEC = resolve(import.meta.dirname, '../docs/api/auth.openapi.yaml');
const MARKER = '\n  schemas:\n';

const isPlainKey = (key) => /^[A-Za-z_$][\w$-]*$/.test(key);
const key = (name) => (isPlainKey(name) ? name : JSON.stringify(name));

/** Chuỗi JSON là chuỗi YAML hợp lệ, nên không cần thư viện YAML. */
function render(value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ' []\n';
    }
    const items = value.map((item) => {
      const body = render(item, indent + 2);
      return body.startsWith('\n') ? `${pad}- ${body.slice(indent + 3)}` : `${pad}-${body}`;
    });
    return `\n${items.join('')}`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return ' {}\n';
    }
    return `\n${entries.map(([name, item]) => `${pad}${key(name)}:${render(item, indent + 2)}`).join('')}`;
  }
  return ` ${JSON.stringify(value)}\n`;
}

const current = readFileSync(SPEC, 'utf8');
const start = current.indexOf(MARKER);
if (start === -1) {
  console.error('LỖI: không thấy dòng "  schemas:" trong file OpenAPI');
  process.exit(1);
}
const head = current.slice(0, start + MARKER.length);
const next = head + render(contracts.authOpenApiSchemas(), 4).slice(1);

if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('LỖI: docs/api/auth.openapi.yaml lệch với zod, chạy pnpm openapi:generate');
    process.exit(1);
  }
  console.log('OpenAPI khớp với zod');
} else {
  writeFileSync(SPEC, next);
  console.log('Đã sinh components/schemas từ zod');
}
