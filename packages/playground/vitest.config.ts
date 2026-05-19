import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // `.test.ts` for pure-function suites + `.test.tsx` for the
    // React-rendering tests under `tests/`. The docs SPA's URI
    // sanitiser is the kind of security code the project rule
    // (`.claude/rules/sanitizer-security.md` §"Testing completeness")
    // mandates adversarial unit-test coverage for; Playwright
    // cannot reach the URI hook because the bundled Markdown
    // sources contain no malicious URIs.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
