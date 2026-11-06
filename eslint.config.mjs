import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Hai thư viện dùng chung — nơi DUY NHẤT một app được phép import code "của repo" từ đó.
const SHARED_LIBS = ['contracts', 'common'];

// Tên package của các app (apps/*). Không ai được import chúng như thư viện.
const APP_PACKAGES = [
  'gateway',
  'auth',
  'inventory',
  'sales',
  'report',
  'backoffice',
  'storefront',
];

const NO_CROSS_APP_MESSAGE =
  'Một app không được import code của app khác. Chỉ import từ libs/ qua @jewelry/contracts hoặc @jewelry/common (xem CLAUDE.md mục 5).';

/** Luật chặn import xuyên app, dùng cho apps/** (và libs/** — libs không được phụ thuộc app). */
const restrictCrossAppImports = {
  'no-restricted-imports': [
    'error',
    {
      paths: APP_PACKAGES.map((name) => ({
        name: `@jewelry/${name}`,
        message: NO_CROSS_APP_MESSAGE,
      })),
      patterns: [
        {
          // @jewelry/<app> và mọi đường dẫn con; libs cũng không cho import sâu vào dist/src.
          group: [
            ...APP_PACKAGES.map((name) => `@jewelry/${name}/**`),
            ...SHARED_LIBS.map((name) => `@jewelry/${name}/**`),
          ],
          message: NO_CROSS_APP_MESSAGE,
        },
        {
          // Đường dẫn tương đối chui ra ngoài rồi vào <app>/src/... (code app nào cũng nằm trong src/).
          regex: String.raw`^(\.\./)+[^/]+/src(/|$)`,
          message: NO_CROSS_APP_MESSAGE,
        },
        {
          // Đường dẫn có dạng .../apps/<tên>/... hoặc .../libs/<tên>/...: dùng @jewelry/* thay vì đường dẫn.
          regex: String.raw`(^|/)(apps|libs)/[^/]+(/|$)`,
          message: NO_CROSS_APP_MESSAGE,
        },
      ],
    },
  ],
};

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/test-build/**',
    '**/.turbo/**',
    '**/coverage/**',
    'apps/*/src/generated/**',
    'secrets/**',
  ]),

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Frontend chạy trên trình duyệt.
  {
    files: ['apps/backoffice/**/*.{ts,tsx}', 'apps/storefront/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Mọi app và lib: chặn import xuyên app.
  {
    files: ['apps/**/*.{ts,tsx,mjs,js}', 'libs/**/*.{ts,tsx,mjs,js}'],
    rules: restrictCrossAppImports,
  },

  // signTestToken ký được token bằng khoá test: code chạy thật không được phép đụng tới.
  {
    files: ['apps/**/*.{ts,tsx,mjs,js}', 'libs/**/*.{ts,tsx,mjs,js}'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...restrictCrossAppImports['no-restricted-imports'][1],
          paths: [
            ...restrictCrossAppImports['no-restricted-imports'][1].paths,
            {
              name: '@jewelry/test-utils',
              message: '@jewelry/test-utils chỉ dùng trong file *.test.ts.',
            },
          ],
        },
      ],
    },
  },

  // Nest dùng decorator + emitDecoratorMetadata nên cần import "giá trị" cho kiểu tham số constructor.
  {
    files: ['apps/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  prettier,
]);
