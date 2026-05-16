#!/usr/bin/env node
// Build script for @chordsketch/wasm-export (HEAVY build).
//
// Companion to @chordsketch/wasm — shares the same underlying
// `chordsketch-wasm` crate but builds with default features
// (`png-pdf` on), pulling in the resvg / tiny-skia / svg2pdf /
// fontdb / harfrust transitive surface required for:
//
//   - renderPdf / renderPdfWithOptions / renderPdfWithWarnings /
//     renderPdfWithWarningsAndOptions  (ChordPro → PDF)
//   - renderIrealPng  (irealb:// → PNG)
//   - renderIrealPdf  (irealb:// → PDF)
//
// Every other entry point that exists in @chordsketch/wasm is
// also present here at the same signature, so a consumer doing
// "just import everything from wasm-export" works — they just pay
// a larger bundle for it. The intended pattern is to import the
// lean @chordsketch/wasm by default and dynamic-import
// @chordsketch/wasm-export ONLY when the user actually requests
// a PDF / PNG export.
//
// Produces the same dual-package layout as @chordsketch/wasm:
//   - web/  : wasm-pack --target web    → ESM
//   - node/ : wasm-pack --target nodejs → CommonJS
//
// Run with: `npm run build` (from packages/npm-export/).

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
  // Default features are on, so the `png-pdf` Cargo feature gates
  // pull `chordsketch-render-pdf` and the resvg / svg2pdf
  // transitive surface into the wasm output. No cargo flag
  // forwarding needed for this side.
  run("wasm-pack", [
    "build",
    CRATE_DIR,
    "--release",
    "--target",
    target,
    "--out-dir",
    outDir,
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

console.log("@chordsketch/wasm-export (heavy) build complete.");
