// Configuration for `@vscode/test-cli`. Runs the extension-host
// integration tests against downloaded VS Code builds.
//
// Tests are authored in TypeScript under `test/integration/` and compiled
// to `out-test/test/integration/` via `tsconfig.integration.json`. The
// `files` pattern below points at the compiled JS, not the TS sources.
//
// See the test-electron + test-cli guide:
//   https://code.visualstudio.com/api/working-with-extensions/testing-extension
//
// The test suite runs against two VS Code versions:
//
//   1. "stable" — the most recent release that real users have installed.
//      Catches regressions that only manifest on the latest VS Code APIs.
//
//   2. The `engines.vscode` floor (kept in sync with `package.json`
//      `engines.vscode`) — the oldest VS Code version we promise to
//      support. Catches accidental use of APIs newer than the declared
//      minimum, which would break install on older VS Code builds.
//
// Both matrix cells exercise every test in `test/integration/`. The
// `.vscode-test/` download cache is shared between them, so only the
// first cold run incurs the VS Code download cost.

import { defineConfig } from "@vscode/test-cli";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read the `engines.vscode` floor from package.json so the matrix cannot
// silently drift if the engines field is bumped.
//
// VS Code extensions use a *simple* prefix range for `engines.vscode`
// (e.g., `"^1.85.0"`, `">=1.85.0"`), never a compound range. Strip the
// leading range operator to get the bare version that `@vscode/test-cli`
// accepts as its `version` field.
//
// We validate the result against the strict `major.minor.patch` shape
// and throw a loud error if anything else leaks through — a compound
// range like `">=1.85.0 <2.0.0"` would otherwise produce
// `"1.85.0 <2.0.0"` and `@vscode/test-cli` would fail with an opaque
// error deep inside the VS Code download path.
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
);
const enginesVscodeFloor = packageJson.engines.vscode.replace(/^[\^~>=<]+/, "");
if (!/^\d+\.\d+\.\d+$/.test(enginesVscodeFloor)) {
  throw new Error(
    `engines.vscode must be a simple prefix range (e.g. "^1.85.0"); ` +
      `after stripping the range operator got ${JSON.stringify(enginesVscodeFloor)}. ` +
      `If you need a compound range, update this config to pick the floor explicitly.`,
  );
}

const sharedTestConfig = {
  files: "out-test/test/integration/**/*.test.js",
  // Workspace is empty by default; tests that open fixture files do so
  // programmatically via `vscode.workspace.openTextDocument`.
  workspaceFolder: "./test/fixtures",
  mocha: {
    ui: "tdd",
    timeout: 60_000, // VS Code startup + extension activation can be slow on cold caches
    color: true,
  },
};

export default defineConfig([
  {
    ...sharedTestConfig,
    label: "stable",
    version: "stable",
  },
  {
    ...sharedTestConfig,
    label: "floor",
    version: enginesVscodeFloor,
  },
]);
