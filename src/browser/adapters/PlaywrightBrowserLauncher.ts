import {
  chromium,
  firefox,
  type BrowserType,
} from 'playwright';

import type { BrowserEngine } from '../../config/AppConfig.js';
import { PlaywrightBrowserAdapter } from './PlaywrightBrowserAdapter.js';
import type {
  BrowserAdapter,
  BrowserLaunchOptions,
  BrowserLauncher,
} from '../types.js';

type BrowserTypeLauncher = Pick<BrowserType, 'launch'>;

export interface PlaywrightBrowserTypes {
  readonly firefox: BrowserTypeLauncher;
  readonly chromium: BrowserTypeLauncher;
}

const DEFAULT_BROWSER_TYPES: PlaywrightBrowserTypes = {
  firefox,
  chromium,
};

export class PlaywrightBrowserLauncher implements BrowserLauncher {
  public constructor(
    private readonly engine: BrowserEngine = 'chromium',
    private readonly browserTypes: PlaywrightBrowserTypes =
      DEFAULT_BROWSER_TYPES,
  ) {}

  public async launch(options: BrowserLaunchOptions): Promise<BrowserAdapter> {
    const browser = await this.browserTypes[this.engine].launch(options);
    return new PlaywrightBrowserAdapter(browser);
  }
}
