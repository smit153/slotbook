// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Design §5.5: Postgres now() is the only clock for booking logic.
 * Service and slot-engine code must never read the JS clock; `now` is passed in
 * from the DB. Logging/metrics code outside these folders may still use Date.
 */
export const clockRule = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
      message: 'Do not read the JS clock in booking logic; use the DB now() passed in (design §5.5).',
    },
    {
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message: 'Do not read the JS clock in booking logic; use the DB now() passed in (design §5.5).',
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/server/**/*.ts', 'test/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/server/services/**/*.ts', 'src/server/engine/**/*.ts'],
    rules: clockRule,
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
