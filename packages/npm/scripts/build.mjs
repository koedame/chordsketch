#!/usr/bin/env node
// Build script for @chordsketch/wasm (LEAN build).
//
// Produces the dual-package layout consumed by package.json `exports`:
//   - web/  : wasm-pack --target web    → ESM (with await init())
//   - node/ : wasm-pack --target nodejs → CommonJS (auto-loads sync)
//
// Each sub-directory carries its own package.json declaring the
// module type so Node resolves them correctly even though the root
// package.json declares "type": "module".
//
// Build profile (#2466):
//   --release: cargo release profile (size-tuned at workspace level,
//              see top-level Cargo.toml [profile.release]).
//   --no-default-features: drops the `png-pdf` Cargo feature on
//              `chordsketch-wasm`, which gates `chordsketch-render-pdf`,
//              `chordsketch-render-ireal/png`, and
//              `chordsketch-render-ireal/pdf` plus every wasm export
//              that depends on them. The heavy renderer surface
//              (resvg / tiny-skia / svg2pdf / usvg / fontdb /
//              harfrust) is published separately via
//              `@chordsketch/wasm-export` so the playground / the
//              `<ChordSheet format="html">` path can load only the
//              parser + lightweight renderers.
//
// Run with: `npm run build` (from packages/npm/).
//
// Mirrors the steps in .github/workflows/npm-publish.yml so local
// builds and CI builds produce **byte-for-byte identical** artifacts
// (verified for the sub-package.json files: pretty-printed JSON with
// 2-space indent and a trailing newline). If you change either, change
// both.

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const CRATE_DIR = resolve(PKG_DIR, "../../crates/wasm");

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Command failed with exit code ${result.status}: ${cmd}`);
    process.exit(result.status ?? 1);
  }
}

function buildTarget(target, outDir) {
  // wasm-pack 0.14.0 has a fragile argument parser: putting
  // `--no-default-features` between `--release` and `--target`
  // makes it consume the next token as `--target`'s value
  // incorrectly. Pass cargo-forwarding flags after the path via
  // the `--` separator so they reach `cargo build` unambiguously.
  run("wasm-pack", [
    "build",
    CRATE_DIR,
    "--release",
    "--target",
    target,
    "--out-dir",
    outDir,
    "--",
    "--no-default-features",
  ]);
}

function writeSubPackageJson(subDir, type) {
  mkdirSync(subDir, { recursive: true });
  const path = resolve(subDir, "package.json");
  writeFileSync(path, JSON.stringify({ type }, null, 2) + "\n");
  console.log(`wrote ${path}`);
}

const webDir = resolve(PKG_DIR, "web");
const nodeDir = resolve(PKG_DIR, "node");

buildTarget("web", webDir);
buildTarget("nodejs", nodeDir);

writeSubPackageJson(webDir, "module");
writeSubPackageJson(nodeDir, "commonjs");

console.log("@chordsketch/wasm (lean) build complete.");
