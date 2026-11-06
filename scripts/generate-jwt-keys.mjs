#!/usr/bin/env node
// Sinh cặp khoá RSA 2048 cho JWT RS256:   pnpm keys:generate [kid]     (mặc định kid = k1)
//   secrets/jwt/private/<kid>.private.pem   chỉ auth được mount
//   secrets/jwt/public/<kid>.public.pem     gateway và các service mount cả thư mục, read-only
// Tách hai thư mục để mount thư mục public không thể kéo theo private key.
// Không bao giờ ghi đè khoá đã có. Không in nội dung khoá.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_KID = 'k1';
const root = resolve(import.meta.dirname, '../secrets/jwt');
const kid = process.argv[2] ?? DEFAULT_KID;

if (!/^[A-Za-z0-9_-]+$/.test(kid)) {
  console.error(`LỖI: kid "${kid}" chỉ được gồm chữ, số, "-" và "_"`);
  process.exit(1);
}

const privatePath = resolve(root, 'private', `${kid}.private.pem`);
const publicPath = resolve(root, 'public', `${kid}.public.pem`);

if (existsSync(privatePath) || existsSync(publicPath)) {
  console.log(`Khoá "${kid}" đã có, giữ nguyên.`);
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

mkdirSync(resolve(root, 'private'), { recursive: true, mode: 0o700 });
mkdirSync(resolve(root, 'public'), { recursive: true, mode: 0o755 });
// flag `wx`: lỗi nếu file đã tồn tại, phòng hai lệnh chạy cùng lúc.
writeFileSync(privatePath, privateKey, { mode: 0o600, flag: 'wx' });
writeFileSync(publicPath, publicKey, { mode: 0o644, flag: 'wx' });

console.log(`Đã tạo khoá "${kid}" trong secrets/jwt/ (private/ và public/).`);
