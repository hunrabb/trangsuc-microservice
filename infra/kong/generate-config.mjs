import { createPublicKey } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const quote = (value) => JSON.stringify(value);

const rateKind = (route) => {
  if (route.name === 'auth-public-login' || route.name === 'shop-auth-public-login' || route.name === 'shop-auth-public-register') return 'login';
  if (route.name === 'auth-public-google') return 'google';
  if (route.name === 'auth-public-refresh' || route.name === 'shop-auth-public-refresh') return 'refresh';
  if (route.name === 'auth-change-password') return 'change-password';
  if (route.name === 'shop') return 'catalog-and-orders';
  if (route.name === 'shop-my-orders') return 'my-orders';
  if (route.name === 'admin-sales') return 'payments';
  return undefined;
};

const routes = [
  ...['google', 'login', 'refresh', 'logout'].map((action) => ({
    name: `auth-public-${action}`,
    path: `/api/auth/${action}`,
    upstream: `http://auth:3000/auth/${action}`,
    exact: true,
    allowTrailingSlash: true,
    priority: 400,
  })),
  ...['register', 'login', 'refresh', 'logout'].map((action) => ({
    name: `shop-auth-public-${action}`,
    path: `/api/shop/auth/${action}`,
    upstream: `http://auth:3000/shop/auth/${action}`,
    exact: true,
    allowTrailingSlash: true,
    priority: 400,
  })),
  {
    name: 'auth-me',
    path: '/api/auth/me',
    upstream: 'http://auth:3000/auth/me',
    exact: true,
    allowTrailingSlash: true,
    ignoreCase: true,
    audience: 'backoffice',
    priority: 300,
  },
  {
    name: 'auth-change-password',
    path: '/api/auth/change-password',
    upstream: 'http://auth:3000/auth/change-password',
    exact: true,
    allowTrailingSlash: true,
    ignoreCase: true,
    audience: 'backoffice',
    priority: 300,
  },
  {
    name: 'auth-logout-all',
    path: '/api/auth/logout-all',
    upstream: 'http://auth:3000/auth/logout-all',
    exact: true,
    allowTrailingSlash: true,
    ignoreCase: true,
    audience: 'backoffice',
    priority: 300,
  },
  {
    name: 'shop-auth-me',
    path: '/api/shop/auth/me',
    upstream: 'http://auth:3000/shop/auth/me',
    exact: true,
    allowTrailingSlash: true,
    ignoreCase: true,
    audience: 'shop',
    priority: 300,
  },
  {
    name: 'shop-my-orders',
    path: '/api/shop/my-orders',
    upstream: 'http://sales:3000/shop/my-orders',
    audience: 'shop',
    ignoreCase: true,
    priority: 250,
  },
  {
    name: 'pos',
    path: '/api/pos',
    upstream: 'http://sales:3000/pos',
    audience: 'backoffice',
    priority: 150,
  },
  {
    name: 'online-orders',
    path: '/api/online-orders',
    upstream: 'http://sales:3000/online-orders',
    audience: 'backoffice',
    priority: 150,
  },
  { name: 'shop', path: '/api/shop', upstream: 'http://sales:3000/shop', priority: 100 },
  {
    name: 'admin-auth',
    path: '/api/admin/auth',
    upstream: 'http://auth:3000/admin',
    audience: 'backoffice',
    priority: 150,
  },
  {
    name: 'admin-inventory',
    path: '/api/admin/inventory',
    upstream: 'http://inventory:3000/admin',
    audience: 'backoffice',
    priority: 150,
  },
  {
    name: 'admin-sales',
    path: '/api/admin/sales',
    upstream: 'http://sales:3000/admin',
    audience: 'backoffice',
    priority: 150,
  },
  {
    name: 'admin-reports',
    path: '/api/admin/reports',
    upstream: 'http://report:3000/admin',
    audience: 'backoffice',
    priority: 150,
  },
  {
    name: 'bank-webhook',
    path: '/webhooks/bank',
    upstream: 'http://sales:3000/webhooks/bank',
    exact: true,
    priority: 300,
  },
  {
    name: 'ping',
    path: '/api/ping',
    upstream: 'http://inventory:3000/internal/ping',
    exact: true,
    priority: 300,
    methods: ['GET'],
  },
];

export function generateConfig({ publicKey, issuer, backofficeAudience, shopAudience }) {
  if (!issuer || !backofficeAudience || !shopAudience || backofficeAudience === shopAudience) {
    throw new Error('JWT issuer và hai audience khác nhau đều phải được cấu hình');
  }
  if (publicKey.includes('PRIVATE KEY')) throw new Error('Không được dùng private key cho Kong');
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error('Kong cần public key RSA tối thiểu 2048 bit');
  }

  const lines = [
    '_format_version: "3.0"',
    'consumers:',
    `  - username: ${quote(issuer)}`,
    '    jwt_secrets:',
    `      - key: ${quote(issuer)}`,
    '        algorithm: RS256',
    '        secret: unused-for-rs256',
    '        rsa_public_key: |-',
    ...publicKey
      .trimEnd()
      .split('\n')
      .map((line) => `          ${line}`),
    'plugins:',
    '  - name: jewelry-request-boundary',
    '  - name: correlation-id',
    '    config:',
    '      header_name: x-correlation-id',
    '      generator: uuid',
    '      echo_downstream: true',
    'services:',
  ];

  for (const route of routes) {
    // Kong 3.9 yêu cầu regex path bắt đầu bằng `~/` (dấu `~` + slash đầu path).
    const prefix = route.ignoreCase ? `~/(?i)${route.path.slice(1)}` : `~${route.path}`;
    const path = route.exact
      ? `${prefix}${route.allowTrailingSlash ? '/?' : ''}$`
      : `${prefix}(?:/|$)`;
    lines.push(
      `  - name: ${route.name}`,
      `    url: ${quote(route.upstream)}`,
      '    retries: 0',
      '    connect_timeout: 3000',
      '    read_timeout: 10000',
      '    write_timeout: 10000',
      '    routes:',
      `      - name: ${route.name}`,
      '        paths:',
      `          - ${quote(path)}`,
      `        regex_priority: ${route.priority}`,
      '        strip_path: true',
      '        path_handling: v0',
      '        plugins:',
      '          - name: jewelry-route-guard',
      '            config:',
      `              prefix: ${quote(route.path)}`,
      `              exact: ${route.exact === true}`,
    );
    if (route.methods) lines.push(`        methods: [${route.methods.join(', ')}]`);
    if (rateKind(route)) {
      lines.push(
        '          - name: jewelry-rate-policy',
        '            config:',
        `              kind: ${quote(rateKind(route))}`,
      );
    }
    if (route.audience) {
      const audience = route.audience === 'shop' ? shopAudience : backofficeAudience;
      lines.push(
        '          - name: jwt',
        '            config:',
        '              key_claim_name: iss',
        '              header_names: [authorization]',
        '              uri_param_names: []',
        '              claims_to_verify: []',
        '          - name: jewelry-jwt-policy',
        '            config:',
        `              issuer: ${quote(issuer)}`,
        `              audience: ${quote(audience)}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.env.JWT_ISSUER === undefined && process.loadEnvFile) {
    process.loadEnvFile(resolve('.env'));
  }
  const output = resolve(process.env.KONG_CANDIDATE_CONFIG ?? '/tmp/jewelry-kong-candidate.yml');
  const config = generateConfig({
    publicKey: readFileSync(resolve('secrets/jwt/public.pem'), 'utf8'),
    issuer: process.env.JWT_ISSUER,
    backofficeAudience: process.env.JWT_AUDIENCE_BACKOFFICE,
    shopAudience: process.env.JWT_AUDIENCE_SHOP,
  });
  // File chỉ chứa public key và route; user `kong` trong container cần quyền đọc bind mount.
  writeFileSync(output, config, { mode: 0o644 });
  chmodSync(output, 0o644);
  process.stdout.write(`Kong candidate config: ${output}\n`);
}
