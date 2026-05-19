import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // The docs SSG URI sanitiser carries the adversarial-input
    // coverage `.claude/rules/sanitizer-security.md` §"Testing
    // completeness" requires — Playwright cannot reach the hook
    // because the canonical Markdown sources contain no malicious
    // URIs.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
