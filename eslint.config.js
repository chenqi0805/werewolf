import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/storybook-static/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The e2e server-runner is plain Node, outside TypeScript's globals.
    files: ['packages/e2e/scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      // Keep type-only imports explicit; pairs with verbatimModuleSyntax.
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  eslintConfigPrettier,
);
