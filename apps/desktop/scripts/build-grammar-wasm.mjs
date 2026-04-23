#!/usr/bin/env node
/**
 * Prebuild step for the desktop frontend:
 *
 *   1. Run `tree-sitter build --wasm` inside
 *      `packages/tree-sitter-chordpro/` to produce
 *      `tree-sitter-chordpro.wasm`. The tree-sitter CLI is already a
 *      devDependency of that package, installed separately via
 *      `npm ci` in its own directory — the `desktop-smoke` CI job
 *      is responsible for running that install before this script.
 *   2. Copy the grammar wasm into `apps/desktop/public/` (served at
 *      the Vite root, resolved at runtime by
 *      `src/codemirror-editor.ts`).
 *   3. Copy the `web-tree-sitter` runtime wasm from node_modules
 *      into the same public dir, because the runtime uses
 *      `locateFile` to resolve its sibling wasm from the page URL.
 *
 * Idempotent — running it twice just overwrites the copies. Both
 * outputs are gitignored; the only source of truth is the generated
 * `src/parser.c` + `scanner.c` + `queries/highlights.scm`.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..', '..');

const grammarDir = resolve(repoRoot, 'packages', 'tree-sitter-chordpro');
const publicDir = resolve(desktopRoot, 'public');

if (!existsSync(publicDir)) {
  mkdirSync(publicDir, { recursive: true });
}

console.log('Building tree-sitter-chordpro.wasm…');
execFileSync('npx', ['tree-sitter', 'build', '--wasm'], {
  cwd: grammarDir,
  stdio: 'inherit',
});

const grammarSrc = resolve(grammarDir, 'tree-sitter-chordpro.wasm');
const grammarDst = resolve(publicDir, 'tree-sitter-chordpro.wasm');
copyFileSync(grammarSrc, grammarDst);
console.log(`Copied ${grammarSrc} → ${grammarDst}`);

// `web-tree-sitter`'s default `locateFile` resolves to the URL the
// JS bundle was loaded from, so shipping `web-tree-sitter.wasm` at
// the same public path lets the runtime find itself without a
// custom loader.
const runtimeSrc = resolve(
  desktopRoot,
  'node_modules',
  'web-tree-sitter',
  'web-tree-sitter.wasm',
);
const runtimeDst = resolve(publicDir, 'web-tree-sitter.wasm');
copyFileSync(runtimeSrc, runtimeDst);
console.log(`Copied ${runtimeSrc} → ${runtimeDst}`);
