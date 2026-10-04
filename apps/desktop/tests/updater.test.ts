import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const messageMock = vi.fn<(...args: unknown[]) => Promise<void>>();
const askMock = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const relaunchMock = vi.fn<() => Promise<void>>();
const checkMock = vi.fn<() => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: askMock,
  message: messageMock,
}));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: relaunchMock }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: checkMock }));

function fakeLocalStorage(fails = false) {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fails) throw new Error('quota exceeded');
      store.set(key, value);
    },
    removeItem: (key: string) => {
      if (fails) throw new Error('quota exceeded');
      store.delete(key);
    },
  };
}

let setIntervalCalls = 0;
let clearIntervalCalls = 0;

function stubWindow(fails = false) {
  setIntervalCalls = 0;
  clearIntervalCalls = 0;
  vi.stubGlobal('window', {
    localStorage: fakeLocalStorage(fails),
    setInterval: () => {
      setIntervalCalls += 1;
      return setIntervalCalls;
    },
    clearInterval: () => {
      clearIntervalCalls += 1;
    },
  });
}

describe('toggleAutoUpdate', () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset().mockResolvedValue(false); // self_update_enabled: false
    messageMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops the loop and persists the preference when the write succeeds', async () => {
    stubWindow(false);
    const { armAutoUpdateLoop, toggleAutoUpdate, isAutoUpdateOptedOut } =
      await import('../src/updater');

    armAutoUpdateLoop();
    expect(setIntervalCalls).toBe(1);
    expect(isAutoUpdateOptedOut()).toBe(false);

    await toggleAutoUpdate();

    expect(isAutoUpdateOptedOut()).toBe(true);
    expect(clearIntervalCalls).toBe(1);
    expect(messageMock).not.toHaveBeenCalled();
  });

  it('restarts the loop when opting back in persists successfully', async () => {
    stubWindow(false);
    const { armAutoUpdateLoop, toggleAutoUpdate, isAutoUpdateOptedOut } =
      await import('../src/updater');

    armAutoUpdateLoop();
    await toggleAutoUpdate(); // opt out
    expect(clearIntervalCalls).toBe(1);

    await toggleAutoUpdate(); // opt back in

    expect(isAutoUpdateOptedOut()).toBe(false);
    expect(setIntervalCalls).toBe(2);
  });

  it('leaves the running loop and the stored preference untouched when the write fails', async () => {
    stubWindow(true);
    const { armAutoUpdateLoop, toggleAutoUpdate, isAutoUpdateOptedOut } =
      await import('../src/updater');

    armAutoUpdateLoop();
    expect(setIntervalCalls).toBe(1);

    await toggleAutoUpdate();

    // The write failed, so the stored (and displayed) preference must
    // not have flipped, and the loop that is actually running must
    // match it — otherwise the Help-menu checkbox would show "checks
    // are on" while the loop had silently been cancelled.
    expect(isAutoUpdateOptedOut()).toBe(false);
    expect(clearIntervalCalls).toBe(0);
    expect(messageMock).toHaveBeenCalledTimes(1);
  });
});
