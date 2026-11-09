import defaultConfig from '@gingacodemonkey/config/eslint';
import type { Linter } from 'eslint';

const config: Linter.Config[] = [
  ...defaultConfig,
  {
    files: ['**/*.ts'],
    // Preserve the existing CLI, graph, and TypeScript conventions during adoption.
    rules: {
      '@typescript-eslint/array-type': 'off',
      'no-await-in-loop': 'off',
      'no-console': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-alphabetical-sort': 'off',
      'sonarjs/no-os-command-from-path': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    // node:test owns the promises returned by top-level test registration.
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', name: 'test', package: 'node:test' }],
      }],
      'big-o/no-array-lookup-in-loop': 'off',
      'sonarjs/no-empty-test-file': 'off',
      'sonarjs/super-linear-regex': 'off',
    },
  },
];

export default config;
