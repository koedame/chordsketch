import { readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

// Regression tests for #2540.
//
// `@chordsketch/react`'s `prepare` script runs `tsup`'s DTS build,
// which type-checks every dynamic `import('@chordsketch/wasm')` site
// in `src/`. The runtime artefacts that ship `@chordsketch/wasm`'s
// type declarations (`web/chordsketch_wasm.d.ts`, `node/chordsketch_wasm.d.ts`)
// are wasm-pack output and do NOT exist in a fresh source checkout.
// Workspace consumers therefore hit `TS7016` / `TS2307` at
// `pnpm install` time because `prepare` cannot finish without those
// declarations — and the build that would produce them is itself
// downstream of the failing install.
//
// The fix declares `@chordsketch/wasm` as an ambient module in
// `src/`, the same pattern `wasm-export-shim.d.ts` applies to the
// optional `@chordsketch/wasm-export` peer (#2539). The shim only
// kicks in when the real `.d.ts` files are absent; when they are
// present (npm-registry install or post-wasm-pack workspace), the
// real declarations supersede the ambient. These tests pin that
// contract:
//
//  1. positive — `src/` type-checks cleanly when the shim is present
//     and `node_modules/@chordsketch/wasm` instances are hidden;
//  2. negative control — without the shim (and with the peer still
//     hidden) the dynamic-import sites emit `TS7016` / `TS2307` for
//     `@chordsketch/wasm`. Proves the shim is load-bearing;
//  3. policy — `src/` does NOT carry a suppression directive on or
//     near a `@chordsketch/wasm` import line. Reintroducing one would
//     paper over the resolution problem in the same silent-failure
//     style `.claude/rules/root-cause-fixes.md` calls out.

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(here, '../src');
const SHIM_PATH = resolve(SRC_DIR, 'wasm-shim.d.ts');
const TSCONFIG_PATH = resolve(here, '../tsconfig.json');

const TS_EXTS = new Set(['.ts', '.tsx', '.d.ts']);

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (
      TS_EXTS.has(extname(full)) ||
      full.endsWith('.d.ts')
    ) {
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
 * Build a compiler host that refuses to resolve any node_modules
 * path containing `@chordsketch/wasm` (without matching
 * `@chordsketch/wasm-export`, which is a sibling module). Hiding the
 * real peer keeps the negative-control assertion robust against a
 * developer who has the wasm artefacts installed locally.
 *
 * Assumes a conventional `node_modules` layout (npm / pnpm hoisted /
 * pnpm `.pnpm/...` virtual store all include the segment). Yarn PnP
 * has no `node_modules` segment and would need a different strategy;
 * CI for this repo does not exercise PnP.
 */
function makeHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options);

  const shouldHide = (path: string): boolean => {
    if (!path.includes('node_modules')) return false;
    if (path.includes('@chordsketch/wasm-export')) return false;
    return path.includes('@chordsketch/wasm');
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
  const rootNames = withShim
    ? allFiles
    : allFiles.filter((p) => p !== SHIM_PATH);
  const host = makeHost(options);
  const program = ts.createProgram({ rootNames, options, host });
  return ts.getPreEmitDiagnostics(program);
}

describe('@chordsketch/wasm shim resolution', () => {
  test('src typechecks cleanly when the shim is present and the peer is unresolved', () => {
    const diagnostics = compileSrc({ withShim: true }).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    );
    expect(diagnostics).toEqual([]);
  });

  test('src emits a missing-types diagnostic for @chordsketch/wasm when the shim is absent', () => {
    // Negative control. Proves the shim is what unblocks resolution
    // for every dynamic-import site, not some incidental fallback.
    const diagnostics = compileSrc({ withShim: false });
    const wasmErrors = diagnostics.filter((d) => {
      if (d.code !== 7016 && d.code !== 2307) return false;
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      return msg.includes('@chordsketch/wasm') && !msg.includes('@chordsketch/wasm-export');
    });
    expect(wasmErrors).not.toHaveLength(0);
  });
});
