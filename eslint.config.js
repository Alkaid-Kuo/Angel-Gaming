// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/** 確定性模組禁用的非確定性 API（core、mapgen、path、replay、shared、config） */
const deterministicRules = {
  'no-restricted-globals': [
    'error',
    { name: 'Date', message: '確定性模組禁用 Date' },
    { name: 'performance', message: '確定性模組禁用 performance' },
    { name: 'setTimeout', message: '確定性模組禁用計時器' },
    { name: 'setInterval', message: '確定性模組禁用計時器' },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: '確定性模組禁用 Math.random，請用 shared/prng' },
    ...['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'log', 'pow', 'hypot', 'cbrt'].map((property) => ({
      object: 'Math',
      property,
      message: `Math.${property} 在不同 JS 引擎可能有誤差，確定性模組禁用`,
    })),
  ],
  'no-restricted-syntax': [
    'error',
    { selector: 'ForInStatement', message: '禁用 for...in（迭代順序依賴物件鍵）' },
  ],
};

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'dist-web/**', 'out/**', 'arms-race/**', 'marshal/**', 'bots/legion-marshal.js', 'bots/legion-general-v2.js', 'bots/legion-marshal-v2.js', 'bots/legion-baseline-v1.68.js', 'bots/legion-baseline-v1.114.js'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true, allowTypedFunctionExpressions: true }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      // 介面文字使用全形空白排版
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: true }],
    },
  },
  {
    files: ['src/core/**', 'src/mapgen/**', 'src/path/**', 'src/replay/**', 'src/shared/**', 'src/config/**', 'src/legion/**', 'src/shooter/**', 'src/manage/**', 'bots/**'],
    ignores: ['src/legion/runner.ts', 'src/shooter/runner.ts'],
    rules: deterministicRules,
  },
  {
    files: ['src/web/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['bots/**/*.js'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
);
