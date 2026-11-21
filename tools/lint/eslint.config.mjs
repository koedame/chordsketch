// Minimal ESLint configuration for the TypeScript packages.
//
// Run from the repository root (CI does the same):
//
//   npm ci --prefix tools/lint
//   npx --prefix tools/lint eslint --config tools/lint/eslint.config.mjs \
//     packages/react packages/react-ui packages/ui-irealb-editor \
//     packages/playground packages/vscode-extension packages/svelte \
//     packages/vue apps/desktop
//
// The directories are passed explicitly: ESLint parses every `.js` / `.mjs`
// it is pointed at, and the other packages (`packages/npm`, the generated
// bindings) are not part of this check. `.svelte` files are not parsed (no
// Svelte parser is installed), so a directive inside one is not verified.
//
// Only the rules listed here run. This is not `eslint:recommended`: the point
// is to make the `eslint-disable` comments in the source mean something
// (`reportUnusedDisableDirectives` fails on a directive that suppresses
// nothing, including one naming a rule that does not exist) and to catch the
// mistakes that `tsc` cannot see — hook dependency arrays, console output in
// shipped code, missing list keys, `dangerouslySetInnerHTML`.
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/pkg/**",
      "**/*.d.ts",
      "**/target/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "18.3" } },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "no-console": "error",
      "react/jsx-key": "error",
      "react/no-danger": "error",
    },
  },
  {
    // Build scripts and fixtures are Node programs whose output is the console,
    // so no rule runs on them. They are still parsed so that a stale
    // `eslint-disable` in one is reported.
    files: ["**/*.{js,mjs,cjs}"],
  },
  {
    // Vue composables are named `useXxx` and call `setup()`-time APIs, which
    // `rules-of-hooks` reads as React hooks called from the wrong place, and
    // `exhaustive-deps` has no meaning for Vue's reactivity. The plugin stays
    // registered so a stray directive naming these rules is reported as unused.
    files: ["packages/vue/**/*.{ts,tsx}", "packages/playground/vue/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
];
