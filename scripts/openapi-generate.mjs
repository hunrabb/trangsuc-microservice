#!/usr/bin/env node
// Sinh phần `components/schemas` của docs/api/*.openapi.yaml (auth, inventory, sales) từ schema zod trong libs/contracts.
//   pnpm openapi:generate           ghi vào file
//   node scripts/openapi-generate.mjs --check   chỉ so sánh, lệch thì thoát mã 1
// Phần `paths` viết tay; không sửa tay từ dòng `schemas:` trở xuống.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import contracts from '../libs/contracts/dist/index.js';

const SPECS = [
  {
    file: resolve(import.meta.dirname, '../docs/api/shop.openapi.yaml'),
    schemas: () => contracts.shopOpenApiSchemas(),
  },
  {
    file: resolve(import.meta.dirname, '../docs/api/auth.openapi.yaml'),
    schemas: () => contracts.authOpenApiSchemas(),
  },
  {
    file: resolve(import.meta.dirname, '../docs/api/inventory.openapi.yaml'),
    schemas: () => contracts.inventoryOpenApiSchemas(),
  },
  {
    file: resolve(import.meta.dirname, '../docs/api/sales.openapi.yaml'),
    schemas: () => contracts.salesOpenApiSchemas(),
  },
];
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

const check = process.argv.includes('--check');
let failed = false;
const only = process.argv
  .find((arg) => arg.startsWith('--only='))
  ?.slice(7)
  .split(',');
for (const { file, schemas } of SPECS.filter(
  (spec) => !only || only.some((name) => spec.file.endsWith(`/${name}.openapi.yaml`)),
)) {
  const current = readFileSync(file, 'utf8');
  const start = current.indexOf(MARKER);
  if (start === -1) {
    console.error(`LỖI: không thấy dòng "  schemas:" trong ${file}`);
    process.exit(1);
  }
  const next = current.slice(0, start + MARKER.length) + render(schemas(), 4).slice(1);
  if (check) {
    if (next !== current) {
      console.error(`LỖI: ${file} lệch với zod, chạy pnpm openapi:generate`);
      failed = true;
    }
  } else {
    writeFileSync(file, next);
  }
}
if (check) {
  if (failed) {
    process.exit(1);
  }
  console.log('OpenAPI khớp với zod');
} else {
  console.log('Đã sinh components/schemas từ zod');
}
