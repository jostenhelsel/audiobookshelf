import tseslint from 'typescript-eslint'

const nodeGlobals = {
  AbortController: 'readonly',
  Buffer: 'readonly',
  fetch: 'readonly',
  TextDecoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  __dirname: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  process: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly'
}

const mochaGlobals = {
  after: 'readonly',
  afterEach: 'readonly',
  before: 'readonly',
  beforeEach: 'readonly',
  describe: 'readonly',
  it: 'readonly'
}

const rules = {
  'no-undef': 'error',
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-class-members': 'error',
  'no-global-assign': 'error'
}

export default [
  {
    ignores: ['**/node_modules/**', 'client/**', 'dist/**', 'dist-server/**', 'coverage/**', 'server/libs/**']
  },
  {
    files: ['index.js', 'prod.js', 'dev.js', 'server/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: nodeGlobals
    },
    rules
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        ...mochaGlobals
      }
    },
    rules
  },
  {
    // TypeScript files: tsc covers undefined/redeclared names, so only the TS-specific escape hatches are linted here
    files: ['index.ts', 'dev.ts', 'server/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        ...mochaGlobals
      }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false, minimumDescriptionLength: 10 }],
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
]
