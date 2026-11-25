// eslint-disable-next-line import/no-nodejs-modules
import path from 'node:path';

// eslint-disable-next-line import/no-nodejs-modules
import { fileURLToPath } from 'node:url';
import config from '@rubensworks/eslint-config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default config([
  {
    files: [ '**/*.ts' ],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: __dirname,
        project: [ './tsconfig.eslint.json' ],
      },
    },
  },
  {
    rules: {
      'unicorn/no-useless-undefined': [
        'error',
        { checkArguments: false },
      ],
      'test/consistent-test-it': 'off',
      'import/extensions': 'off',

      // Default
      'unicorn/consistent-destructuring': 'off',
      'unicorn/no-array-callback-reference': 'off',

      'ts/naming-convention': 'off',
      'ts/no-unsafe-return': 'off',
      'ts/no-unsafe-argument': 'off',
      'ts/no-unsafe-assignment': 'off',

      'ts/no-require-imports': [ 'error', { allow: [
        'process/',
        'is-stream',
        'readable-stream-node-to-web',
      ]}],
      'ts/no-var-requires': [ 'error', { allow: [
        'process/',
        'is-stream',
        'readable-stream-node-to-web',
      ]}],
    },
  },
  {
    // Specific rules for NodeJS-specific files
    files: [
      '**/test/**/*.ts',
      // The benchmark runner drives git and vitest, so it is a Node script rather than library code.
      '**/test/**/*.mjs',
    ],
    rules: {
      'import/no-nodejs-modules': 'off',
      'ts/no-require-imports': 'off',
      'ts/no-var-requires': 'off',
      // The benchmark runner really is a CLI, and reports a bad revision or a dirty tree by exiting.
      'unicorn/no-process-exit': 'off',
    },
  },
  {
    // Some test files import 'vitest' which triggers this
    // Some jest test import '../../lib' which triggers this
    files: [
      '**/*.test.ts',
      '**/*.bench.ts',
      '**/*.util.ts',
    ],
    rules: {
      'import/no-extraneous-dependencies': 'off',
    },
  },
  {
    files: [
      '**/*.md',
      '**/*.md/*.ts',
    ],
    rules: {
      'unused-imports/no-unused-imports-ts': 'off',
      'ts/no-require-imports': 'off',
      'ts/no-var-requires': 'off',
    },
  },
  {
    ignores: [
      'documentation',
      // Working documents rather than sources: the task, the design it was turned into, and the per-PR
      // plan. Their code blocks are algebra sketches and interface excerpts, not files the build compiles,
      // so `parserOptions.project` has nothing to type-check them against.
      'task.md',
      'report.md',
      'agent-task.md',
    ],
  },
], { disableJest: true });
