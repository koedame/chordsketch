/**
 * Help-menu entries for the update check: a checkbox that turns the
 * automatic check on and off, and a one-shot "Check for Updates Now".
 *
 * Returns nothing for an installation that does not update itself
 * (Flatpak: the store delivers new versions), so the menu never offers
 * a switch that does nothing.
 */
import {
  CheckMenuItem,
  MenuItem,
  PredefinedMenuItem,
} from '@tauri-apps/api/menu';

import { isAutoUpdateOptedOut, isSelfUpdateEnabled } from './updater';

interface UpdateMenuActions {
  toggleAutoUpdate: () => Promise<void>;
  checkForUpdatesNow: () => Promise<void>;
  rebuildMenu: () => Promise<void>;
}

export async function buildUpdateMenuItems(
  actions: UpdateMenuActions,
): Promise<Array<PredefinedMenuItem | CheckMenuItem | MenuItem>> {
  if (!(await isSelfUpdateEnabled())) return [];
  return Promise.all([
    PredefinedMenuItem.new({ item: 'Separator' }),
    CheckMenuItem.new({
      id: 'help-check-for-updates-automatically',
      text: 'Check for Updates Automatically',
      checked: !isAutoUpdateOptedOut(),
      action: () => {
        // The native item flips its own checkmark on click; rebuilding
        // resets it to the stored preference. `toggleAutoUpdate` only
        // starts or stops the check loop once that preference actually
        // persisted, so the checkmark this redraws to always matches
        // whether checks will actually happen — including when the
        // save itself failed.
        void actions.toggleAutoUpdate().then(actions.rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'help-check-for-updates-now',
      text: 'Check for Updates Now',
      action: () => {
        void actions.checkForUpdatesNow();
      },
    }),
  ]);
}
