import tseslint from 'typescript-eslint'
import functional from 'eslint-plugin-functional'

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'contract/node_modules/**',
      'contract/dist/**',
      'src/generated/**',
      '.testaipack/**',
      'coverage/**',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', '*.config.{js,mjs,cjs}'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: {
      functional,
    },
    rules: {
      'functional/immutable-data': 'error',
      'functional/no-let': 'error',
      'functional/prefer-readonly-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'functional/no-let': 'off',
      'functional/immutable-data': 'off',
      'functional/prefer-readonly-type': 'off',
    },
  },
  {
    // Low-level subprocess seam: stream collection is inherently stateful
    // (chunk accumulation, closure/exit flags across async callbacks).
    files: ['src/opencode/spawn.ts'],
    rules: {
      'functional/no-let': 'off',
      'functional/immutable-data': 'off',
      'functional/prefer-readonly-type': 'off',
    },
  },
]
