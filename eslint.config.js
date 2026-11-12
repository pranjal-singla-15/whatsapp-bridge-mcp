// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', '*.config.*'] },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // stdout is reserved for the MCP protocol; all diagnostics must go through the logger (stderr).
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Interface implementations are intentionally `async` even without `await`, so that
      // synchronous throws (e.g. NOT_CONNECTED) surface as rejections, never as sync exceptions.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['src/cli/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Plain Node maintenance scripts (run in CI); not part of the TS program.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' },
    },
  },
);
