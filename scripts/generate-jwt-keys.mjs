#!/usr/bin/env node
// Sinh cặp khoá RSA 2048 cho JWT RS256:   pnpm keys:generate
//   secrets/jwt/private.pem   chỉ auth được mount
//   secrets/jwt/public.pem    gateway và các service mount read-only
// Không bao giờ ghi đè khoá đã có: đổi khoá thì chuyển hai file cũ đi trước (xem README).
// Không in nội dung khoá.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../secrets/jwt');
const privatePath = resolve(root, 'private.pem');
const publicPath = resolve(root, 'public.pem');

if (existsSync(privatePath) || existsSync(publicPath)) {
  console.log('Khoá đã có, giữ nguyên.');
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

mkdirSync(root, { recursive: true, mode: 0o700 });
// flag `wx`: lỗi nếu file đã tồn tại, phòng hai lệnh chạy cùng lúc.
writeFileSync(privatePath, privateKey, { mode: 0o600, flag: 'wx' });
writeFileSync(publicPath, publicKey, { mode: 0o644, flag: 'wx' });

console.log('Đã tạo secrets/jwt/private.pem và secrets/jwt/public.pem.');
