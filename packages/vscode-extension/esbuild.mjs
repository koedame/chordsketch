#!/usr/bin/env node
/**
 * Build script for the ChordSketch VS Code extension.
 *
 * Produces two bundles:
 *   dist/extension.js    — Extension host (Node.js, CJS)
 *   dist/webview/preview.js — WebView script (browser, ESM)
 *
 * Also copies:
 *   syntaxes/*.json       → dist/syntaxes/
 *   packages/npm/web/chordsketch_wasm_bg.wasm → dist/webview/
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const watch = process.argv.includes('--watch');

// Ensure output directories exist.
fs.mkdirSync(path.join(here, 'dist', 'syntaxes'), { recursive: true });
fs.mkdirSync(path.join(here, 'dist', 'webview'), { recursive: true });

// Copy VS Code-required files from repo root syntaxes/.
const syntaxesSrc = path.join(repoRoot, 'syntaxes');
const syntaxesDst = path.join(here, 'dist', 'syntaxes');
// Clean destination first to avoid stale files from previous builds.
if (fs.existsSync(syntaxesDst)) {
  fs.rmSync(syntaxesDst, { recursive: true });
}
fs.mkdirSync(syntaxesDst, { recursive: true });
for (const file of [
  'chordpro.tmLanguage.json',
  'language-configuration.json',
  'irealb-language-configuration.json',
]) {
  const src = path.join(syntaxesSrc, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(syntaxesDst, file));
    console.log(`Copied syntaxes/${file}`);
  } else {
    throw new Error(`Required syntax file not found: ${src}`);
  }
}

// Copy the WASM binary for the WebView (browser build).
// Prefer the local monorepo build over the installed npm package so a
// developer (or CI step) that runs `node packages/npm-export/scripts/build.mjs`
// against the in-tree `crates/wasm` source picks up new exports
// immediately, without waiting for a manual `npm publish` cycle. The
// node_modules copy from `npm install @chordsketch/wasm-export` remains
// a fallback for ad-hoc clones where a Rust toolchain is unavailable.
//
// `@chordsketch/wasm-export` (NOT the lean `@chordsketch/wasm`) is
// used here because the extension host's `convertToPdf` command
// (commands.ts) calls `render_pdf`, which only exists in the heavy
// bundle since #2466. The WebView side also pulls the heavy bundle
// to keep the build script simple — the WebView could in principle
// use the lean variant since it only renders HTML preview, but
// loading two wasm copies into the same extension distribution
// doubles the install footprint without a runtime win for a local
// VS Code install.
const wasmLocalWeb = path.join(repoRoot, 'packages', 'npm-export', 'web', 'chordsketch_wasm_bg.wasm');
const wasmNpmWeb = path.join(here, 'node_modules', '@chordsketch', 'wasm-export', 'web', 'chordsketch_wasm_bg.wasm');
// Fallback to the lean `@chordsketch/wasm` package when the heavy
// `wasm-export` build is unavailable — the WebView only needs HTML /
// text preview, which is the lean bundle's exact surface (per the
// alias / fallback set up below for the JS glue).
const wasmNpmWebLean = path.join(here, 'node_modules', '@chordsketch', 'wasm', 'web', 'chordsketch_wasm_bg.wasm');
const wasmSrc = fs.existsSync(wasmLocalWeb)
  ? wasmLocalWeb
  : fs.existsSync(wasmNpmWeb)
    ? wasmNpmWeb
    : wasmNpmWebLean;
const wasmDst = path.join(here, 'dist', 'webview', 'chordsketch_wasm_bg.wasm');
if (fs.existsSync(wasmSrc)) {
  fs.copyFileSync(wasmSrc, wasmDst);
  console.log(`Copied ${path.relative(here, wasmSrc)} → dist/webview/chordsketch_wasm_bg.wasm`);
} else {
  console.warn('WARNING: chordsketch_wasm_bg.wasm not found in node_modules or local build.');
  console.warn('         Run `npm install` in packages/vscode-extension/ to fetch @chordsketch/wasm-export.');
}

// Copy the WASM Node.js CJS build for the extension host (convertTo command).
// The files are NOT bundled by esbuild — they are loaded at runtime via require()
// so that the module's own __dirname resolves to dist/node/ where the .wasm binary lives.
// Clean the directory first to prevent stale artifacts from accumulating across builds.
const nodeDir = path.join(here, 'dist', 'node');
if (fs.existsSync(nodeDir)) {
  fs.rmSync(nodeDir, { recursive: true });
}
fs.mkdirSync(nodeDir, { recursive: true });
// Write a package.json declaring CJS type so Node resolves the .js as CommonJS.
fs.writeFileSync(path.join(nodeDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
const wasmNodeFiles = ['chordsketch_wasm.js', 'chordsketch_wasm_bg.wasm'];
for (const file of wasmNodeFiles) {
  // Same precedence rule as the web copy above — local in-tree build
  // first, npm-published HEAVY fallback second, lean fallback third.
  // The heavy bundle is preferred because the extension host calls
  // `render_pdf` from `convertToPdf` — but if neither heavy build is
  // available locally the lean variant still gives the WebView its
  // preview surface and only `convertToPdf` regresses.
  const localSrc = path.join(repoRoot, 'packages', 'npm-export', 'node', file);
  const npmSrc = path.join(here, 'node_modules', '@chordsketch', 'wasm-export', 'node', file);
  const npmLeanSrc = path.join(here, 'node_modules', '@chordsketch', 'wasm', 'node', file);
  const src = fs.existsSync(localSrc)
    ? localSrc
    : fs.existsSync(npmSrc)
      ? npmSrc
      : npmLeanSrc;
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(nodeDir, file));
    console.log(`Copied ${path.relative(here, src)} → dist/node/${file}`);
  } else {
    console.warn(`WARNING: dist/node/${file} not found in node_modules or local build.`);
    console.warn('         Run `npm install` in packages/vscode-extension/ to fetch @chordsketch/wasm-export.');
  }
}

/** @type {esbuild.BuildOptions} */
const extensionBuild = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

// The WebView bundle imports from the wasm-pack web target's JS glue.
// Prefer the local monorepo build over the installed npm package — see
// the matching comment on the binary copy above for the rationale.
const wasmJsLocal = path.join(repoRoot, 'packages', 'npm-export', 'web', 'chordsketch_wasm.js');
const wasmJsNpm = path.join(here, 'node_modules', '@chordsketch', 'wasm-export', 'web', 'chordsketch_wasm.js');
// Fallback to the lean `@chordsketch/wasm` package when neither the
// in-tree nor the npm-installed `wasm-export` build is available — the
// WebView side only needs parse + HTML / text render, which is the
// lean bundle's exact surface. The extension host side keeps using
// the heavy `wasm-export` build at runtime for the `convertToPdf`
// command (see the comments around the dist/node/ copy above).
const wasmJsNpmLean = path.join(here, 'node_modules', '@chordsketch', 'wasm', 'web', 'chordsketch_wasm.js');
const wasmJsSrc = fs.existsSync(wasmJsLocal)
  ? wasmJsLocal
  : fs.existsSync(wasmJsNpm)
    ? wasmJsNpm
    : wasmJsNpmLean;

// The React component library — `@chordsketch/react` and its sibling
// `@chordsketch/react/styles.css` import. The published package's
// `main` / `module` field already resolves to `dist/index.js`, but we
// alias to the in-tree TypeScript source so a local change to a React
// component shows up in the next esbuild run without having to rebuild
// the React package separately. Mirrors the pattern in
// `packages/playground/vite.config.ts`. The longer specifier
// (`/styles.css`) MUST be listed before the bare package alias so
// esbuild matches it first.
const reactPkgDir = path.resolve(repoRoot, 'packages', 'react');
const reactSrcEntry = path.join(reactPkgDir, 'src', 'index.ts');
const reactSrcCss = path.join(reactPkgDir, 'src', 'styles.css');
const reactDistEntry = path.join(reactPkgDir, 'dist', 'index.js');
const reactDistCss = path.join(reactPkgDir, 'dist', 'styles.css');
const reactEntry = fs.existsSync(reactSrcEntry) ? reactSrcEntry : reactDistEntry;
const reactCss = fs.existsSync(reactSrcCss) ? reactSrcCss : reactDistCss;

// `@chordsketch/react`'s source files import from bare specifiers like
// `react`, `react/jsx-runtime`, and `react-dom/client`. When esbuild
// bundles the in-tree source via the `@chordsketch/react` alias above,
// it resolves those bare specifiers from the importing file's
// directory upward — but `packages/react/node_modules/` is NOT
// installed in the vscode-extension CI job, and the React-package
// devDeps live there. Resolve every React specifier explicitly
// against the vscode-extension's own `node_modules/react` /
// `node_modules/react-dom` (declared as production deps in
// packages/vscode-extension/package.json), so the WebView bundle
// reaches a guaranteed copy of React regardless of whether the
// sibling React package has had its deps installed.
const vscodeReactDir = path.resolve(here, 'node_modules', 'react');
const vscodeReactDomDir = path.resolve(here, 'node_modules', 'react-dom');
const vscodeReactJsxRuntime = path.join(vscodeReactDir, 'jsx-runtime.js');
const vscodeReactDomClient = path.join(vscodeReactDomDir, 'client.js');

/** @type {esbuild.BuildOptions} */
const webviewBuild = {
  entryPoints: ['webview/preview.tsx'],
  bundle: true,
  outfile: 'dist/webview/preview.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
  // Inline the React + @chordsketch/react + wasm glue into a single
  // bundle the VS Code WebView loads via `<script type="module">`.
  // Dynamic `import('@chordsketch/wasm')` calls inside the React
  // hooks reach the same bundled module, so the wasm init we run on
  // mount short-circuits subsequent `default()` calls in the hooks.
  splitting: false,
  jsx: 'automatic',
  // Production React drops the `__DEV__` branches. The CSP only
  // allows `'wasm-unsafe-eval'`, so any dev-mode helper that touches
  // `new Function(...)` would be rejected at runtime.
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // Inject `react`, `react-dom`, and the React library into the bundle
  // — the WebView has no module resolver of its own.
  external: [],
  loader: {
    '.css': 'text',
  },
  alias: {
    // Resolve @chordsketch/wasm to the web (browser) build of the WASM package,
    // matching the pattern used in packages/playground/vite.config.ts.
    '@chordsketch/wasm': wasmJsSrc,
    // Same trick for the heavy variant: any transitive import from
    // `@chordsketch/react` that reaches `@chordsketch/wasm-export`
    // (e.g. the lazy `<PdfExport>` chunk) is steered at the lean
    // wasm — the VS Code WebView's preview surface drops PDF from
    // the format selector anyway. We keep the alias rather than
    // marking it external so an accidental tree-shake miss does not
    // emit an unresolvable `import('@chordsketch/wasm-export')`.
    '@chordsketch/wasm-export': wasmJsSrc,
    '@chordsketch/react/styles.css': reactCss,
    '@chordsketch/react': reactEntry,
    // React + ReactDOM specifier aliases. The in-tree
    // `@chordsketch/react` source imports bare `react`,
    // `react/jsx-runtime`, and `react-dom/client`; without these
    // aliases esbuild starts resolution in
    // `packages/react/node_modules/`, which is not populated in
    // the vscode-extension CI job (the React package's deps live
    // there as devDeps). Point each specifier directly at this
    // package's own `node_modules/react*` so the WebView bundle
    // always reaches a populated copy. The longer specifiers
    // MUST be listed before the bare package aliases so esbuild
    // matches them first.
    'react/jsx-runtime': vscodeReactJsxRuntime,
    'react-dom/client': vscodeReactDomClient,
    'react': vscodeReactDir,
    'react-dom': vscodeReactDomDir,
  },
};

if (watch) {
  const [extCtx, wvCtx] = await Promise.all([
    esbuild.context(extensionBuild),
    esbuild.context(webviewBuild),
  ]);
  await Promise.all([extCtx.watch(), wvCtx.watch()]);
  console.log('Watching for changes...');
} else {
  await Promise.all([
    esbuild.build(extensionBuild),
    esbuild.build(webviewBuild),
  ]);
}
