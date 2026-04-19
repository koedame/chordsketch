/**
 * Shared helpers for the `test/integration/` suites.
 *
 * Extracted so the contributed-command list, fixture-path resolution,
 * and extension-activation bootstrap live in a single place — adding a
 * new command or renaming the fixture directory touches one file, not
 * four.
 */

import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Commands the extension contributes via `package.json#contributes.commands`.
 *
 * Single source of truth for the integration tests' command-registration
 * assertions. A new command added to `package.json` should also be added
 * here; the activation test will then assert its presence automatically.
 */
export const CONTRIBUTED_COMMANDS: readonly string[] = [
  "chordsketch.openPreview",
  "chordsketch.openPreviewToSide",
  "chordsketch.transposeUp",
  "chordsketch.transposeDown",
  "chordsketch.convertTo",
];

/**
 * Resolve a file in `test/fixtures/` by walking up from the compiled
 * test location.
 *
 * Tests compile to `out-test/test/integration/*.js`; fixtures live at
 * `test/fixtures/` (source tree root relative to the package). The
 * three-`..` traversal matches `out-test/test/integration/ →
 * out-test/ → packages/vscode-extension/` where the `test/` directory
 * sits.
 */
export function fixture(name: string): vscode.Uri {
  const fixtureDir = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "test",
    "fixtures",
  );
  return vscode.Uri.file(path.join(fixtureDir, name));
}

/**
 * Open `hello.cho` in the active column (triggers the
 * `onLanguage:chordpro` activation event) and ensure the extension is
 * active. Shared bootstrap for every `suiteSetup` in this folder.
 */
export async function activateExtension(): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(fixture("hello.cho"));
  await vscode.window.showTextDocument(doc);
  const extension = vscode.extensions.getExtension("koedame.chordsketch");
  assert.ok(
    extension,
    "koedame.chordsketch extension must be installed in the extension-dev host",
  );
  if (!extension.isActive) {
    await extension.activate();
  }
  assert.ok(extension.isActive, "extension must be active after activation");
}

/**
 * Assert that every command in [`CONTRIBUTED_COMMANDS`] is currently
 * registered with VS Code. `filterInternal: true` skips VS Code's
 * built-in command ids so the diff is specific to extension contributions.
 */
export async function assertAllContributedCommandsRegistered(): Promise<void> {
  const registered = new Set(
    await vscode.commands.getCommands(/* filterInternal */ true),
  );
  const missing = CONTRIBUTED_COMMANDS.filter((cmd) => !registered.has(cmd));
  assert.deepEqual(
    missing,
    [],
    `contributed commands must be registered; missing: ${JSON.stringify(missing)}`,
  );
}
