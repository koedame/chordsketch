import { beforeEach, describe, expect, it, vi } from 'vitest';

const optedOut = vi.fn<() => boolean>();
const selfUpdateEnabled = vi.fn<() => Promise<boolean>>();

vi.mock('../src/updater', () => ({
  isAutoUpdateOptedOut: () => optedOut(),
  isSelfUpdateEnabled: () => selfUpdateEnabled(),
}));

type ItemOptions = {
  id?: string;
  text?: string;
  checked?: boolean;
  action?: () => void;
};

vi.mock('@tauri-apps/api/menu', () => {
  const make = (kind: string) => ({
    new: async (options: ItemOptions) => ({ kind, ...options }),
  });
  return {
    CheckMenuItem: make('check'),
    MenuItem: make('item'),
    PredefinedMenuItem: make('predefined'),
  };
});

import { buildUpdateMenuItems } from '../src/update-menu';

function actions() {
  return {
    toggleAutoUpdate: vi.fn(async () => {}),
    checkForUpdatesNow: vi.fn(async () => {}),
    rebuildMenu: vi.fn(async () => {}),
  };
}

async function build(a = actions()) {
  const items = (await buildUpdateMenuItems(a)) as unknown as Array<
    ItemOptions & { kind: string }
  >;
  return { items, a };
}

describe('buildUpdateMenuItems', () => {
  beforeEach(() => {
    optedOut.mockReset().mockReturnValue(false);
    selfUpdateEnabled.mockReset().mockResolvedValue(true);
  });

  it('adds no items when the installation does not update itself', async () => {
    selfUpdateEnabled.mockResolvedValue(false);
    const { items } = await build();
    expect(items).toEqual([]);
  });

  it('lists a separator, the automatic-check toggle, then check-now when the installation updates itself', async () => {
    const { items } = await build();
    expect(items.map((i) => i.text ?? i.kind)).toEqual([
      'predefined',
      'Check for Updates Automatically',
      'Check for Updates Now',
    ]);
    expect(items[1].kind).toBe('check');
  });

  it('checks the toggle when automatic checks are on', async () => {
    optedOut.mockReturnValue(false);
    const { items } = await build();
    expect(items[1].checked).toBe(true);
  });

  it('unchecks the toggle when the user has opted out', async () => {
    optedOut.mockReturnValue(true);
    const { items } = await build();
    expect(items[1].checked).toBe(false);
  });

  it('toggles the preference, then rebuilds the menu, when the toggle is clicked', async () => {
    const a = actions();
    const order: string[] = [];
    a.toggleAutoUpdate.mockImplementation(async () => {
      order.push('toggle');
    });
    a.rebuildMenu.mockImplementation(async () => {
      order.push('rebuild');
    });
    const { items } = await build(a);
    items[1].action!();
    await vi.waitFor(() => expect(order).toEqual(['toggle', 'rebuild']));
  });

  it('checks for updates without touching the preference when check-now is clicked', async () => {
    const { items, a } = await build();
    items[2].action!();
    expect(a.checkForUpdatesNow).toHaveBeenCalledTimes(1);
    expect(a.toggleAutoUpdate).not.toHaveBeenCalled();
    expect(a.rebuildMenu).not.toHaveBeenCalled();
  });
});
