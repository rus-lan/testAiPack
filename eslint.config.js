import tseslint from 'typescript-eslint'
import functional from 'eslint-plugin-functional'

export default [
  {
    // Allowlist, not a denylist: ignore everything, then un-ignore only the
    // project's own source locations (bin/, contract/, scripts/, src/,
    // tests/, the two root config files). A run workspace is excluded by
    // construction regardless of what `--workspace <name>` calls it —
    // `updateGitignore()` writes the real name into .gitignore for git, but
    // eslint has no such per-run mechanism, so the allowlist has to be the
    // fixed, known-good set instead of guessing at workspace names.
    ignores: [
      '**',
      '!bin/**',
      '!contract/**',
      '!scripts/**',
      '!src/**',
      '!tests/**',
      '!eslint.config.js',
      '!vitest.config.ts',
      'contract/node_modules/**',
      'contract/dist/**',
      'src/generated/**',
      'src/**/*.d.ts',
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
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
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
  {
    // Effect.async resume-guard flag (`let settled`) — no object/array
    // mutation here, so only `no-let` needs relaxing.
    files: ['src/util/git.ts'],
    rules: {
      'functional/no-let': 'off',
    },
  },
  {
    // Phase 06 run coordinator: a soft hang-watchdog races the opencode spawn
    // while an `onEvent` bridge accumulates streamed events into shared state.
    // This concurrent stateful coordination is the same shape as spawn.ts.
    files: ['src/phases/06-run-side.ts'],
    rules: {
      'functional/no-let': 'off',
      'functional/immutable-data': 'off',
      'functional/prefer-readonly-type': 'off',
    },
  },
  {
    // clipanion command classes are OOP by design: instance fields backing
    // Option.* declarations and `static paths`/`usage` must stay mutable.
    files: ['src/cli/index.ts'],
    rules: {
      'functional/prefer-readonly-type': 'off',
    },
  },
]
