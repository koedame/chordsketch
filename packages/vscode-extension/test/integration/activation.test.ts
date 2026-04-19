/**
 * Integration test: extension activation + command registration.
 *
 * Foundational regression gate for issue #1914. `activateExtension()`
 * opens a `.cho` fixture (which triggers the extension's
 * `onLanguage:chordpro` activation event) and
 * `assertAllContributedCommandsRegistered()` checks every
 * `package.json`-contributed command reaches
 * `vscode.commands.getCommands(true)`. A future refactor of
 * `activate()` that propagates an error before
 * `context.subscriptions.push` runs would silently drop commands and
 * be caught here.
 *
 * Run from `packages/vscode-extension/`:
 *
 *   npm run test:integration    # non-display environments add xvfb-run
 *
 * The runner downloads a pinned VS Code build on first run; subsequent
 * runs reuse it.
 */

import {
  activateExtension,
  assertAllContributedCommandsRegistered,
} from "./helpers.js";

suite("extension activation", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test("every contributed command is registered after activation", async () => {
    await assertAllContributedCommandsRegistered();
  });
});
