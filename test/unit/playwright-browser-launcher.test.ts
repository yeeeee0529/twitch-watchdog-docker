import type { Browser, BrowserType } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { PlaywrightBrowserAdapter } from '../../src/browser/adapters/PlaywrightBrowserAdapter.js';
import {
  PlaywrightBrowserLauncher,
  type PlaywrightBrowserTypes,
} from '../../src/browser/adapters/PlaywrightBrowserLauncher.js';

function createBrowserTypes() {
  const browser = {} as Browser;
  const firefoxLaunch = vi.fn(async () => browser);
  const chromiumLaunch = vi.fn(async () => browser);
  const browserTypes: PlaywrightBrowserTypes = {
    firefox: {
      launch: firefoxLaunch as BrowserType['launch'],
    },
    chromium: {
      launch: chromiumLaunch as BrowserType['launch'],
    },
  };
  return { browserTypes, chromiumLaunch, firefoxLaunch };
}

describe('PlaywrightBrowserLauncher', () => {
  it('default engine 使用 Chromium 並回傳共用 adapter', async () => {
    const { browserTypes, chromiumLaunch, firefoxLaunch } =
      createBrowserTypes();
    const launcher = new PlaywrightBrowserLauncher(
      undefined,
      browserTypes,
    );

    const adapter = await launcher.launch({ headless: true });

    expect(chromiumLaunch).toHaveBeenCalledWith({ headless: true });
    expect(firefoxLaunch).not.toHaveBeenCalled();
    expect(adapter).toBeInstanceOf(PlaywrightBrowserAdapter);
  });

  it('firefox engine 仍使用 Firefox 並回傳同一 adapter', async () => {
    const { browserTypes, chromiumLaunch, firefoxLaunch } =
      createBrowserTypes();
    const launcher = new PlaywrightBrowserLauncher(
      'firefox',
      browserTypes,
    );

    const adapter = await launcher.launch({ headless: true });

    expect(firefoxLaunch).toHaveBeenCalledWith({ headless: true });
    expect(chromiumLaunch).not.toHaveBeenCalled();
    expect(adapter).toBeInstanceOf(PlaywrightBrowserAdapter);
  });

  it('chromium engine 使用 Chromium 並回傳同一 adapter', async () => {
    const { browserTypes, chromiumLaunch, firefoxLaunch } =
      createBrowserTypes();
    const launcher = new PlaywrightBrowserLauncher(
      'chromium',
      browserTypes,
    );

    const adapter = await launcher.launch({ headless: false });

    expect(chromiumLaunch).toHaveBeenCalledWith({ headless: false });
    expect(firefoxLaunch).not.toHaveBeenCalled();
    expect(adapter).toBeInstanceOf(PlaywrightBrowserAdapter);
  });
});
