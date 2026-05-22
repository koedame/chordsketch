import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

// Regression tests for #2539.
//
// The bug: when the dynamic-import site for the optional peer
// `@chordsketch/wasm-export` was guarded with a suppression directive
// (`@ts-expect-error` / `@ts-ignore`), the directive's behaviour
// flipped with the consumer's resolution state for the peer. In the
// resolved case `@ts-expect-error` became a dead directive and the
// package's DTS build failed, breaking the consumer's install through
// the `prepare` hook. In the unresolved case `@ts-ignore` silently
// swallowed unrelated diagnostics on the same line (typos in the
// module specifier, cast mismatches, etc.) — the silent-failure
// pattern called out by `.claude/rules/root-cause-fixes.md`.
//
// The fix replaces the directive with an ambient module declaration
// (the optional-peer shim under `src/`) so resolution succeeds in
// both states without any suppression at the call site. These tests
// pin that contract from three angles:
//
//  1. positive — the source type-checks cleanly against the shim
//     with NO node_modules instance of the peer present;
//  2. negative control — without the shim (and with the real peer
//     hidden), resolution genuinely fails (`TS2307`). Proves the
//     shim is load-bearing rather than incidentally redundant;
//  3. policy — the source must NOT reintroduce any suppression
//     directive (`@ts-expect-error` / `@ts-ignore` / `@ts-nocheck`).

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(here, '../src/use-pdf-export.ts');
const SHIM_PATH = resolve(here, '../src/wasm-export-shim.d.ts');
const TSCONFIG_PATH = resolve(here, '../tsconfig.json');

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
 * Build a compiler host that, when `hidePeer` is true, refuses to
 * resolve any node_modules path containing `@chordsketch/wasm-export`.
 * This keeps the negative-control test robust against a developer who
 * happens to have the optional peer installed locally: hiding the
 * node_modules instance forces the resolver to rely on whatever
 * ambient declarations (shim or otherwise) are passed in via
 * `rootNames`.
 *
 * The filter assumes a conventional `node_modules` layout (npm /
 * pnpm hoisted / pnpm `.pnpm/...` virtual store — all of which carry
 * `node_modules` and the peer's package directory in the path). A
 * Yarn PnP environment has no `node_modules` segment and would need
 * a different strategy; CI for this repo does not exercise PnP.
 */
function makeHost(
  options: ts.CompilerOptions,
  { hidePeer }: { hidePeer: boolean },
): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  if (!hidePeer) return host;

  const shouldHide = (path: string): boolean =>
    path.includes('node_modules') && path.includes('@chordsketch/wasm-export');

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

function compileWithPeerHidden(rootNames: string[]): readonly ts.Diagnostic[] {
  const options = loadCompilerOptions();
  const host = makeHost(options, { hidePeer: true });
  const program = ts.createProgram({ rootNames, options, host });
  return ts.getPreEmitDiagnostics(program);
}

describe('use-pdf-export optional-peer import resolution', () => {
  test('source typechecks cleanly when the shim is present and the peer is unresolved', () => {
    const diagnostics = compileWithPeerHidden([SOURCE_PATH, SHIM_PATH]).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    );
    expect(diagnostics).toEqual([]);
  });

  test('source emits TS2307 for @chordsketch/wasm-export when the shim is absent and the peer is unresolved', () => {
    // Negative control. Proves the shim is what unblocks resolution;
    // hiding node_modules instances of the peer keeps this assertion
    // robust to a developer who has the optional peer installed
    // locally.
    const diagnostics = compileWithPeerHidden([SOURCE_PATH]);
    const ts2307 = diagnostics.filter(
      (d) =>
        d.code === 2307 &&
        ts
          .flattenDiagnosticMessageText(d.messageText, '\n')
          .includes('@chordsketch/wasm-export'),
    );
    expect(ts2307).not.toHaveLength(0);
  });

  test('source does not suppress diagnostics on the dynamic import line', () => {
    // A future contributor reintroducing `@ts-expect-error` would
    // recreate #2539 in any consumer environment where the peer
    // auto-resolves; `@ts-ignore` would silently swallow unrelated
    // errors; a file-scope `@ts-nocheck` would disable the entire
    // file's type-checks and bypass even the shim. Catch all three
    // by forbidding any `@ts-*` suppression directive in the file.
    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(source).not.toMatch(/@ts-(?:expect-error|ignore|nocheck)\b/);
  });
});
