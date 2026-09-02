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
 * Wired as `build.beforeBundleCommand` in `tauri.windows.conf.json`,
 * so it runs after the app binary is built and before the MSI / NSIS
 * bundles are assembled. The staging hop exists because cargo writes
 * the DLL into a target-triple-dependent path, while
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
  // The preview handler is a Windows COM server; on any other platform
  // the crate compiles to an empty library and there is nothing to
  // stage. Refusing loudly beats staging a `.so` nothing will load.
  console.error(
    `${DLL_NAME} can only be built on Windows (this is ${process.platform}). ` +
      'This script is wired into tauri.windows.conf.json only.',
  );
  process.exit(1);
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
