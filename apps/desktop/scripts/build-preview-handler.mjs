#!/usr/bin/env node
/**
 * Bundle step for the Windows preview handler:
 *
 *   1. Build `chordsketch-preview-handler` (a cdylib) in release mode
 *      for the same target triple the Tauri bundle is being built for.
 *   2. Stage the resulting DLL at
 *      `apps/desktop/src-tauri/windows/bin/`, where
 *      `tauri.windows.conf.json`'s `bundle.resources` picks it up and
 *      installs it next to the app executable.
 *
 * Wired into the `prebuild` / `predev` npm hooks, alongside
 * `build-grammar-wasm.mjs`, so it has run by the time `cargo tauri
 * build` / `cargo tauri dev` reaches the Rust build. That timing is
 * load-bearing: `tauri-build`'s build script resolves
 * `bundle.resources` while compiling `chordsketch-desktop`, and a
 * declared resource that does not exist yet fails the build long
 * before the bundling phase. The staging hop itself exists because
 * cargo writes the DLL into a target-triple-dependent path, while
 * `bundle.resources` needs one fixed path relative to
 * `tauri.conf.json`.
 *
 * Idempotent — running it twice just overwrites the staged copy. The
 * staged DLL is gitignored; the crate under
 * `apps/desktop/preview-handler/` is the source of truth.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..', '..');

const CRATE = 'chordsketch-preview-handler';
// Must match `DLL_FILE_NAME` in
// `apps/desktop/preview-handler/src/registration.rs`, which is what the
// two installers write into the registry.
const DLL_NAME = 'chordsketch_preview_handler.dll';

if (process.platform !== 'win32') {
  // The preview handler is a Windows COM server, and only
  // `tauri.windows.conf.json` declares it as a bundle resource, so
  // there is nothing to stage anywhere else. The hooks that call this
  // script are cross-platform, so say what was skipped rather than
  // failing the frontend build on macOS and Linux.
  console.log(
    `Skipping ${DLL_NAME}: the preview handler is Windows-only ` +
      `(this platform is ${process.platform}).`,
  );
  process.exit(0);
}

// Tauri sets TAURI_ENV_TARGET_TRIPLE for the build hooks. Fall back to
// the host triple so the script also works when run by hand.
const targetTriple =
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n')
    .find((line) => line.startsWith('host: '))
    ?.slice('host: '.length)
    .trim();

if (!targetTriple) {
  throw new Error('Could not determine the Rust target triple to build for');
}

console.log(`Building ${CRATE} for ${targetTriple}…`);
execFileSync(
  'cargo',
  ['build', '--release', '--package', CRATE, '--target', targetTriple],
  { cwd: repoRoot, stdio: 'inherit' },
);

const builtDll = resolve(repoRoot, 'target', targetTriple, 'release', DLL_NAME);
if (!existsSync(builtDll)) {
  throw new Error(`cargo reported success but ${builtDll} does not exist`);
}

const stagingDir = resolve(desktopRoot, 'src-tauri', 'windows', 'bin');
mkdirSync(stagingDir, { recursive: true });
const stagedDll = resolve(stagingDir, DLL_NAME);
copyFileSync(builtDll, stagedDll);
console.log(`Copied ${builtDll} → ${stagedDll}`);
