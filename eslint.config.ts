import defaultConfig from '@gingacodemonkey/config/eslint';
import type { Linter } from 'eslint';

const config: Linter.Config[] = [
  ...defaultConfig,
  {
    files: ['**/*.ts'],
    // Preserve the existing CLI, graph, and TypeScript conventions during adoption.
    rules: {
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/promise-function-async': 'off',
      'big-o/no-array-lookup-in-loop': 'off',
      'de-morgan/no-negated-disjunction': 'off',
      'no-await-in-loop': 'off',
      'no-console': 'off',
      'promise/param-names': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-alphabetical-sort': 'off',
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-os-command-from-path': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    // node:test registration and fixture assertions use these forms intentionally.
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      'no-useless-escape': 'off',
      'sonarjs/no-empty-test-file': 'off',
      'sonarjs/prefer-regexp-exec': 'off',
      'sonarjs/super-linear-regex': 'off',
    },
  },
];

export default config;
