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
//     carries a suppression directive (`@ts-expect-error`,
//     `@ts-ignore`, `@ts-nocheck`, or a triple-slash reference that
//     bypasses the shim). Reintroducing one would paper over the
//     resolution problem in the same silent-failure style
//     `.claude/rules/root-cause-fixes.md` calls out.

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(here, '../src');
const SHIM_PATH = resolve(SRC_DIR, 'wasm-shim.d.ts');
const TSCONFIG_PATH = resolve(here, '../tsconfig.json');

const TS_EXTS = new Set(['.ts', '.tsx']);
const WASM_MODULE = '@chordsketch/wasm';
const SUPPRESSION_RE = /@ts-(?:expect-error|ignore|nocheck)\b/;
// Forbid only triple-slash directives that actively route around
// the shim — pointing at the wasm-pack output or its module name.
// Generic `/// <reference types="vite/client"/>` style references
// remain allowed.
const WASM_REFERENCE_RE =
  /\/\/\/\s*<reference\s+(?:path|types)\s*=\s*['"][^'"]*(?:@chordsketch\/wasm|chordsketch_wasm)[^'"]*['"]/;

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
 *   - `packages/npm/{web,node}/chordsketch_wasm.*` (the
 *     workspace-relative wasm-pack artefact path that
 *     `tsconfig.json`'s `paths` mapping points at)
 *
 * Hiding both keeps the assertions accurate regardless of whether
 * the developer has run `wasm-pack build` locally — without the
 * `packages/npm/` filter, the positive test could silently pass via
 * the real wasm-pack output rather than the shim. The sibling
 * `@chordsketch/wasm-export` ambient is left in place so its own
 * regression test (`tests/use-pdf-export-optional-peer.test.ts`)
 * stays unaffected when run alongside this one.
 *
 * NOTE: the `packages/npm/` filter is keyed on the basename
 * `chordsketch_wasm` (the wasm-pack output filename) so unrelated
 * files under `packages/npm/` are not hidden. If `tsconfig.json`'s
 * `paths` value ever changes to point elsewhere, update this filter
 * — the comment in `tsconfig.json` next to `paths` flags it.
 */
function makeHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options);

  const shouldHide = (path: string): boolean => {
    if (path.includes('@chordsketch/wasm-export')) return false;
    if (path.includes('node_modules') && path.includes('@chordsketch/wasm')) {
      return true;
    }
    if (path.includes('packages/npm/') && path.includes('chordsketch_wasm')) {
      return true;
    }
    return false;
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
  // `ts.createProgram` with explicit `rootNames` builds the program
  // from those roots and their transitive imports only — it does not
  // re-walk `tsconfig.json`'s `include` globs. So filtering the shim
  // out of `rootNames` is sufficient to keep its ambient declaration
  // out of the program when `withShim: false`.
  const rootNames = withShim
    ? allFiles
    : allFiles.filter((p) => p !== SHIM_PATH);
  const host = makeHost(options);
  const program = ts.createProgram({ rootNames, options, host });
  return ts.getPreEmitDiagnostics(program);
}

/**
 * Discover every `src/` source file that contains a dynamic
 * `import('@chordsketch/wasm')` call expression, including
 * template-literal arguments (`` import(`@chordsketch/wasm`) ``)
 * that a literal-string regex would miss. AST discovery also
 * excludes false positives the regex would otherwise hit — the
 * shim's own header comment names the call-syntax exemplar, and a
 * regex on file content would treat that as a real import site.
 */
function discoverWasmImportSites(): string[] {
  const out: string[] = [];
  for (const path of collectSourceFiles(SRC_DIR)) {
    if (!TS_EXTS.has(extname(path))) continue;
    if (path.endsWith('.d.ts')) continue;
    const text = readFileSync(path, 'utf8');
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (containsWasmImport(sf)) out.push(path);
  }
  return out;
}

function containsWasmImport(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1
    ) {
      const arg = node.arguments[0];
      if (ts.isStringLiteralLike(arg) && arg.text === WASM_MODULE) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
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
    const expectedSites = discoverWasmImportSites();
    // Guard against the silent regression where every site is
    // refactored away or the discovery helper breaks — without this
    // the `>=` assertion would pass vacuously with 0 errors against
    // 0 expected sites.
    expect(expectedSites.length).toBeGreaterThan(0);

    const diagnostics = compileSrc({ withShim: false });
    const wasmErrors = diagnostics.filter((d) => {
      if (d.code !== 7016 && d.code !== 2307) return false;
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      return msg.includes('@chordsketch/wasm') && !msg.includes('@chordsketch/wasm-export');
    });
    const filesWithErrors = new Set(
      wasmErrors.map((d) => d.file?.fileName).filter((n): n is string => Boolean(n)),
    );
    // Asserting "≥ every site that imports the module" pins the
    // shim's claim that it unblocks the entire dynamic-import
    // surface. A future refactor that drops some sites is welcome;
    // a future refactor that drops the shim and silently leaves
    // some sites failing is the regression class we want to catch.
    expect(filesWithErrors.size).toBeGreaterThanOrEqual(expectedSites.length);
  });

  test('src files importing @chordsketch/wasm carry no suppression directive or wasm-targeting triple-slash reference', () => {
    // Sibling-test symmetry with #2541's wasm-export shim policy
    // (`tests/use-pdf-export-optional-peer.test.ts`). A future
    // contributor reintroducing `@ts-expect-error`, `@ts-ignore`,
    // `@ts-nocheck`, or a `/// <reference path="...wasm..."/>` near
    // a `@chordsketch/wasm` import would recreate the silent-failure
    // class `.claude/rules/root-cause-fixes.md` warns about — the
    // directive would silently flip between dead and load-bearing
    // depending on consumer resolution state. The shim's whole
    // point is to make every such directive unnecessary.
    const sites = discoverWasmImportSites();
    expect(sites.length).toBeGreaterThan(0);

    const offending: string[] = [];
    for (const path of sites) {
      const source = readFileSync(path, 'utf8');
      if (SUPPRESSION_RE.test(source) || WASM_REFERENCE_RE.test(source)) {
        offending.push(path);
      }
    }
    expect(offending).toEqual([]);
  });
});
