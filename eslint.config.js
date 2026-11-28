// ESLint, flat config. Aimed at real bugs, not style - formatting is Prettier's
// job (.prettierrc) and none of the rule sets below have an opinion on it.
//
// Levels follow one policy: a rule the code already satisfies is `error`, so
// it stays satisfied; a rule with many existing hits is `warn` until they are
// burned down, then it becomes `error` too. `npm run lint` fails on errors
// only; `npm run lint:strict` fails on warnings as well, for when the list
// below is empty.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

const TS_AND_VUE = ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.vue'];

// Files no tsconfig includes (build configs, script typings, and the Electron tests that
// tsconfig.electron.json leaves out). They are linted without type
// information rather than added to a project just for the linter.
const UNTYPED = ['**/vite.config.ts', '**/vitest.config.ts', 'capacitor.config.ts', 'scripts/**/*.d.mts', 'apps/print-desk/electron/**/*.test.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/build/**',
      '**/coverage/**',
      'android/**',
      // Reference material kept verbatim next to the code ported from it.
      'modules/customs-ch/legacy/**',
      'modules/customs-de/ihb-reference/**',
      // Server runtime data and stores (published bundles, APKs).
      'apps/server/data/**',
      'apps/server/modules-store/**',
      'apps/server/shell-store/**',
      'apps/server/apk/**',
      'apps/server/deploy/**',
      '.claude/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: TS_AND_VUE })),
  // `essential` is the error-prevention set; the larger Vue sets are mostly
  // template style (attribute order, casing) and would fight the formatter.
  ...vue.configs['flat/essential'],

  // Type-aware linting. projectService finds each file's own tsconfig.json, so
  // every workspace is checked under the compiler options it is built with.
  {
    files: TS_AND_VUE,
    ignores: [...UNTYPED, 'apps/print-desk/electron/**'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
  },
  // The Electron main process has its own project (tsconfig.electron.json),
  // which projectService would not find: it only looks for tsconfig.json.
  {
    files: ['apps/print-desk/electron/**/*.ts'],
    ignores: UNTYPED,
    languageOptions: {
      parserOptions: {
        project: ['apps/print-desk/tsconfig.electron.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, sourceType: 'module' },
    },
  },

  // Where the code runs.
  {
    files: ['apps/web/**', 'apps/print-desk/src/**', 'modules/**', 'packages/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/**', 'apps/server/**', 'apps/print-desk/electron/**', 'packages/server-core/**', '**/*.config.{js,ts,mjs}', '**/*.cjs'],
    languageOptions: { globals: globals.node },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },

  {
    files: TS_AND_VUE,
    rules: {
      // TypeScript resolves identifiers itself, and knows the ambient types
      // (vite/client, vitest/globals, the DOM lib) that no-undef does not.
      'no-undef': 'off',
    },
  },

  // --- Rules chosen on top of the recommended sets -------------------------
  //
  // error: clean today, kept clean.
  {
    rules: {
      // `x == null` (null or undefined) is the one loose comparison that is an
      // idiom rather than an accident; every other `==` is an error.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'vue/no-v-html': 'error',
      'vue/require-v-for-key': 'error',
      'vue/no-unused-components': 'error',
      // Only when nothing in the destructuring is reassigned: splitting
      // `let [a, b] = await Promise.all(...)` to const one name helps nobody.
      'prefer-const': ['error', { destructuring: 'all' }],
      // Naming convention, not a defect; the Print Desk app has Icon.vue and Menu.vue.
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: TS_AND_VUE,
    rules: {
      // `sdk?.log.info(m) ?? console.info(m)` and `ok && run()` are how this
      // code writes a guarded call; a bare `a === b;` is still reported.
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },
  {
    files: TS_AND_VUE,
    ignores: UNTYPED,
    rules: {
      // A promise nobody awaits loses its rejection: the sale that did not
      // save, the upload that failed, reported nowhere. `void` marks the few
      // that are meant to run on their own.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // warn: the burn-down list. Each rule here has existing hits (count as of
  // the commit that added this file); fix them, then move the rule up to
  // `error`. Do not silence them with eslint-disable comments.
  {
    linterOptions: {
      // 1: apps/web/src/lib/captcha.ts disables a rule that is not enabled.
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // 2: regexes that strip control characters on purpose (server-core/
      // problems.ts, shared/booth-layout.ts). Three more already carry an
      // eslint-disable-next-line; these two want the same or a \p{Cc} class.
      'no-control-regex': 'warn',
      'no-useless-assignment': 'warn', // 11
      'preserve-caught-error': 'warn', // 8
      'no-useless-escape': 'warn', // 6
      'vue/no-mutating-props': 'warn', // 8, all in packages/ui/src/DeclarantForm.vue
      'vue/valid-v-for': 'warn', // 1, apps/web/src/views/PrepPlannerView.vue
    },
  },
  {
    files: TS_AND_VUE,
    rules: {
      // 19
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: TS_AND_VUE,
    ignores: UNTYPED,
    rules: {
      // 12: an async function handed to something that ignores the promise it
      // returns (an event listener, a timer), so a rejection goes unhandled.
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/await-thenable': 'warn', // 1, apps/print-desk/src/PriceCards.vue
    },
  },
);
