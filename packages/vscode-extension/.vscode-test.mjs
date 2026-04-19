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
// `engines.vscode` is semver-range style (e.g., "^1.85.0"); strip the
// leading range operator and use the bare version for the test-cli
// `version` field, which takes a concrete version string.
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
);
const enginesVscodeFloor = packageJson.engines.vscode.replace(/^[\^~>=<]+/, "");

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
