#!/usr/bin/env node
/**
 * Bundle step for the macOS Quick Look preview extension:
 *
 *   1. Build `chordsketch-preview-handler` as a static library for
 *      each architecture of the Tauri target. The crate's manifest
 *      only declares a `cdylib` (the Windows COM server), so the
 *      crate type is chosen here with `cargo rustc --crate-type`.
 *   2. Compile `src-tauri/macos/quicklook/PreviewProvider.swift`
 *      against that library into the extension executable, and `lipo`
 *      the architectures together for a universal build.
 *   3. Assemble `ChordSketchQuickLook.appex` at
 *      `apps/desktop/src-tauri/macos/build/`, where
 *      `tauri.macos.conf.json`'s `bundle.macOS.files` copies it into
 *      `ChordSketch.app/Contents/PlugIns/`.
 *   4. Sign it, sandboxed, with `APPLE_SIGNING_IDENTITY` — or ad hoc
 *      (`-`) when that is unset.
 *
 * Signing happens here, not in the Tauri bundler, because the bundler
 * signs only the app's own binaries and then the app bundle, without
 * `--deep`: files placed through `bundle.macOS.files` keep whatever
 * signature they arrive with. That is also what we want — the
 * extension has to carry its own entitlements (macOS will not load an
 * app extension outside the App Sandbox), which a deep re-sign with the
 * app's entitlements would strip. `codesign` refuses to sign a bundle
 * with unsigned nested code, so this step is not optional even for an
 * otherwise unsigned build.
 *
 * Wired into the `prebuild` npm hook, so it has run by the time
 * `cargo tauri build` reaches the bundling phase. Not wired into
 * `predev`: `cargo tauri dev` runs the bare binary, never a bundle, so
 * there is nothing for the extension to be embedded in.
 *
 * Idempotent — the staged bundle is rebuilt from scratch on every run.
 * It is gitignored; the sources under `src-tauri/macos/quicklook/` and
 * `apps/desktop/preview-handler/` are the source of truth.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const tauriDir = resolve(desktopRoot, 'src-tauri');
const sourceDir = resolve(tauriDir, 'macos', 'quicklook');

const CRATE = 'chordsketch-preview-handler';
const STATIC_LIB = 'libchordsketch_preview_handler.a';
// Must match `EXTENSION_NAME` in
// `apps/desktop/preview-handler/src/quicklook.rs`, which asserts that
// the Info.plist and `tauri.macos.conf.json` agree with it.
const EXTENSION_NAME = 'ChordSketchQuickLook';
// `QLPreviewProvider` — the data-based preview API — is macOS 12+.
// Must match `LSMinimumSystemVersion` in the extension's Info.plist.
const MINIMUM_MACOS = '12.0';

if (process.platform !== 'darwin') {
  // Only `tauri.macos.conf.json` embeds the extension, and building it
  // needs `swiftc` and `codesign`. The hook that calls this script is
  // cross-platform, so say what was skipped rather than failing the
  // frontend build on Linux and Windows.
  console.log(
    `Skipping ${EXTENSION_NAME}.appex: the Quick Look extension is ` +
      `macOS-only (this platform is ${process.platform}).`,
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

// Rust target triple → the architecture name `swiftc -target` and
// `lipo` use.
const ARCHES = {
  'aarch64-apple-darwin': 'arm64',
  'x86_64-apple-darwin': 'x86_64',
};
const rustTargets =
  targetTriple === 'universal-apple-darwin' ? Object.keys(ARCHES) : [targetTriple];
for (const target of rustTargets) {
  if (!(target in ARCHES)) {
    throw new Error(`Cannot build ${EXTENSION_NAME}.appex for target ${target}`);
  }
}

const buildDir = resolve(tauriDir, 'macos', 'build');
const workDir = resolve(buildDir, 'work');
const appex = resolve(buildDir, `${EXTENSION_NAME}.appex`);
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const executables = rustTargets.map((target) => {
  const arch = ARCHES[target];
  console.log(`Building ${CRATE} as a static library for ${target}…`);
  execFileSync(
    'cargo',
    ['rustc', '--release', '--package', CRATE, '--target', target, '--crate-type', 'staticlib'],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  const staticLib = resolve(repoRoot, 'target', target, 'release', STATIC_LIB);
  if (!existsSync(staticLib)) {
    throw new Error(`cargo reported success but ${staticLib} does not exist`);
  }

  console.log(`Compiling ${EXTENSION_NAME} for ${arch}…`);
  const executable = resolve(workDir, `${EXTENSION_NAME}-${arch}`);
  execFileSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-target', `${arch}-apple-macos${MINIMUM_MACOS}`,
      '-module-name', EXTENSION_NAME,
      // Restricts the code to API available to app extensions, as
      // Xcode does for an extension target.
      '-application-extension',
      '-parse-as-library',
      '-import-objc-header', resolve(sourceDir, `${EXTENSION_NAME}.h`),
      // An app extension has no `main`: Foundation's
      // `NSExtensionMain` starts the extension point's run loop and
      // instantiates `NSExtensionPrincipalClass`.
      '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
      resolve(sourceDir, 'PreviewProvider.swift'),
      staticLib,
      '-o', executable,
    ],
    { stdio: 'inherit' },
  );
  return executable;
});

const contents = resolve(appex, 'Contents');
mkdirSync(resolve(contents, 'MacOS'), { recursive: true });
const bundledExecutable = resolve(contents, 'MacOS', EXTENSION_NAME);
if (executables.length === 1) {
  copyFileSync(executables[0], bundledExecutable);
} else {
  execFileSync('lipo', ['-create', ...executables, '-output', bundledExecutable], {
    stdio: 'inherit',
  });
}

// The extension ships at the app's version; tauri.conf.json is the one
// place that version is written for the bundle.
const { version } = JSON.parse(readFileSync(resolve(tauriDir, 'tauri.conf.json'), 'utf8'));
const infoPlist = resolve(contents, 'Info.plist');
copyFileSync(resolve(sourceDir, 'Info.plist'), infoPlist);
for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
  execFileSync('plutil', ['-insert', key, '-string', version, infoPlist], { stdio: 'inherit' });
}
execFileSync('plutil', ['-lint', infoPlist], { stdio: 'inherit' });

// The same variable the Tauri bundler reads for the app itself, so the
// extension and its host are signed by one identity. Without it both
// stay ad hoc / unsigned, which is enough to run the extension on the
// machine that built it but not to pass Gatekeeper on another one.
const identity = process.env.APPLE_SIGNING_IDENTITY || '-';
const signArgs = [
  '--force',
  '--sign', identity,
  // Hardened runtime, which notarization requires of every executable.
  '--options', 'runtime',
  '--entitlements', resolve(sourceDir, 'QuickLook.entitlements'),
];
if (identity !== '-') {
  // A secure timestamp is also required for notarization; an ad hoc
  // signature cannot carry one.
  signArgs.push('--timestamp');
}
console.log(`Signing ${EXTENSION_NAME}.appex with identity "${identity}"…`);
execFileSync('codesign', [...signArgs, appex], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', '--verbose=2', appex], { stdio: 'inherit' });

rmSync(workDir, { recursive: true, force: true });
console.log(`Staged ${appex}`);
