import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

// Regression tests for #2540. See `src/wasm-shim.d.ts` for why the
// ambient declaration exists. The tests pin its contract from three
// angles:
//
//  1. positive — `src/` type-checks cleanly with the shim present
//     and every other resolution path for `@chordsketch/wasm`
//     hidden;
//  2. negative control — without the shim (every other resolution
//     path still hidden) every dynamic-import site emits a
//     missing-types diagnostic. Proves the shim is load-bearing for
//     the entire surface, not just one representative site;
//  3. policy — no file in `src/` that imports `@chordsketch/wasm`
//     carries a `@ts-(expect-error|ignore|nocheck)` directive.
//     Reintroducing one would paper over the resolution problem in
//     the same silent-failure style `.claude/rules/root-cause-fixes.md`
//     calls out.

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(here, '../src');
const SHIM_PATH = resolve(SRC_DIR, 'wasm-shim.d.ts');
const TSCONFIG_PATH = resolve(here, '../tsconfig.json');

const TS_EXTS = new Set(['.ts', '.tsx']);
const WASM_IMPORT_RE = /import\(\s*['"]@chordsketch\/wasm['"]\s*\)/;
const SUPPRESSION_RE = /@ts-(?:expect-error|ignore|nocheck)\b/;

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (TS_EXTS.has(extname(full)) || full.endsWith('.d.ts')) {
      // `extname('foo.d.ts')` returns '.ts' so the second clause is
      // belt-and-braces against a future TS_EXTS change that drops
      // '.ts'.
      out.push(full);
    }
  }
  return out;
}

function loadCompilerOptions(): ts.CompilerOptions {
  const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (configFile.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(TSCONFIG_PATH),
  );
  return { ...parsed.options, noEmit: true };
}

/**
 * Build a compiler host that refuses to resolve `@chordsketch/wasm`
 * via any of the project's two primary resolution paths:
 *
 *   - `node_modules/@chordsketch/wasm/...` (npm-registry install,
 *     pnpm hoisted, pnpm `.pnpm/...` virtual store)
 *   - `packages/npm/...` (the workspace-relative path that
 *     `tsconfig.json`'s `paths` mapping points at)
 *
 * Hiding both keeps the assertions accurate regardless of whether
 * the developer has run `wasm-pack build` locally — without the
 * `packages/npm/` filter, the positive test could silently pass via
 * the real wasm-pack output rather than the shim. The sibling
 * `@chordsketch/wasm-export` ambient is left in place so its own
 * regression test (`tests/use-pdf-export-optional-peer.test.ts`)
 * stays unaffected when run alongside this one.
 */
function makeHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options);

  const shouldHide = (path: string): boolean => {
    if (path.includes('@chordsketch/wasm-export')) return false;
    if (!path.includes('@chordsketch/wasm') && !path.includes('packages/npm/'))
      return false;
    return path.includes('node_modules') || path.includes('packages/npm/');
  };

  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (path) => (shouldHide(path) ? false : originalFileExists(path));
  host.readFile = (path) => (shouldHide(path) ? undefined : originalReadFile(path));
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    shouldHide(path)
      ? undefined
      : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  return host;
}

function compileSrc({ withShim }: { withShim: boolean }): readonly ts.Diagnostic[] {
  const options = loadCompilerOptions();
  const allFiles = collectSourceFiles(SRC_DIR);
  // Fail loud if the shim was renamed without updating SHIM_PATH —
  // otherwise the `withShim: false` filter would silently become a
  // no-op and the negative control would degrade to a duplicate of
  // the positive test.
  if (!allFiles.includes(SHIM_PATH)) {
    throw new Error(
      `Test setup invariant: expected shim file at ${SHIM_PATH}. ` +
        `Update SHIM_PATH if the shim was renamed; otherwise the ` +
        `negative control degrades silently.`,
    );
  }
  const rootNames = withShim
    ? allFiles
    : allFiles.filter((p) => p !== SHIM_PATH);
  const host = makeHost(options);
  const program = ts.createProgram({ rootNames, options, host });
  return ts.getPreEmitDiagnostics(program);
}

describe('@chordsketch/wasm shim resolution', () => {
  test('src typechecks cleanly when the shim is present and every other peer-resolution path is hidden', () => {
    // The positive test compiles the entire `src/` tree because the
    // production failure (the package's pre-publish DTS build) also
    // type-checks the whole tree. Any unrelated TS regression
    // elsewhere in `src/` will fail this test with a noisy message —
    // that is intentional: the contract is "src/ compiles", not
    // "the import site compiles in isolation".
    const diagnostics = compileSrc({ withShim: true }).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    );
    expect(diagnostics).toEqual([]);
  });

  test('every src file dynamically importing @chordsketch/wasm emits a missing-types diagnostic when the shim is absent', () => {
    // Negative control. The filter accepts TS2307 (no module found
    // anywhere) AND TS7016 (declaration file missing for a JS
    // module). Which code fires depends on whether the runtime
    // bundle is present alongside the missing `.d.ts`; the test
    // accepts either. A future wasm-pack change that shipped a stub
    // `.d.ts` with incomplete exports would shift the diagnostic
    // class (TS2305 / TS2339), in which case this test needs
    // updating — that is intentional, the test pins the current
    // failure mode.
    const diagnostics = compileSrc({ withShim: false });
    const wasmErrors = diagnostics.filter((d) => {
      if (d.code !== 7016 && d.code !== 2307) return false;
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      return msg.includes('@chordsketch/wasm') && !msg.includes('@chordsketch/wasm-export');
    });
    const filesWithErrors = new Set(
      wasmErrors.map((d) => d.file?.fileName).filter((n): n is string => Boolean(n)),
    );
    const expectedSites = collectSourceFiles(SRC_DIR).filter((p) => {
      if (!TS_EXTS.has(extname(p))) return false;
      if (p.endsWith('.d.ts')) return false;
      const source = readFileSync(p, 'utf8');
      return WASM_IMPORT_RE.test(source);
    });
    // Asserting "≥ every site that imports the module" pins the
    // shim's claim that it unblocks the ENTIRE dynamic-import
    // surface. A future refactor that drops some sites is welcome;
    // a future refactor that drops the shim and silently leaves
    // some sites failing is the regression class we want to catch.
    expect(filesWithErrors.size).toBeGreaterThanOrEqual(expectedSites.length);
  });

  test('src files importing @chordsketch/wasm carry no suppression directive', () => {
    // Sibling-test symmetry with #2541's wasm-export shim policy
    // (`tests/use-pdf-export-optional-peer.test.ts`). A future
    // contributor reintroducing `@ts-expect-error`,
    // `@ts-ignore`, or `@ts-nocheck` near a `@chordsketch/wasm`
    // import would recreate the silent-failure class
    // `.claude/rules/root-cause-fixes.md` warns about — the
    // directive would silently flip between dead and load-bearing
    // depending on consumer resolution state. The shim's whole
    // point is to make every such directive unnecessary.
    const offending: string[] = [];
    for (const path of collectSourceFiles(SRC_DIR)) {
      if (!TS_EXTS.has(extname(path))) continue;
      if (path.endsWith('.d.ts')) continue;
      const source = readFileSync(path, 'utf8');
      if (!WASM_IMPORT_RE.test(source)) continue;
      if (SUPPRESSION_RE.test(source)) offending.push(path);
    }
    expect(offending).toEqual([]);
  });
});
