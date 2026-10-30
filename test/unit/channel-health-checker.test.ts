import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_HEALTH_SELECTORS,
  evaluateChannelHealth,
} from '../../src/browser/ChannelHealthChecker.js';

const TARGET_URL = 'https://www.twitch.tv/streamer_one';

interface HealthSnapshot {
  readonly loginRequired: boolean;
  readonly loggedOut?: boolean;
  readonly error: boolean;
  readonly offline: boolean;
  readonly liveContent: boolean;
  readonly unsupportedPlayerError: boolean;
}

function createPage(
  snapshot: HealthSnapshot,
  options: {
    readonly contentWarning?: boolean;
    readonly contentWarningClickError?: Error;
  } = {},
): {
  readonly page: Page;
  readonly evaluate: ReturnType<typeof vi.fn>;
  readonly locator: ReturnType<typeof vi.fn>;
  readonly warningClick: ReturnType<typeof vi.fn>;
} {
  let liveVisible = snapshot.liveContent;
  const evaluate = vi.fn(async () => snapshot);
  const warningClick = vi.fn(async () => {
    if (options.contentWarningClickError !== undefined) {
      throw options.contentWarningClickError;
    }
    liveVisible = true;
  });
  const locator = vi.fn((selector: string) => {
    const mockLocator = {
      first(): Locator {
        return mockLocator as unknown as Locator;
      },
      async isVisible(): Promise<boolean> {
        if (selector === CHANNEL_HEALTH_SELECTORS.contentWarning) {
          return options.contentWarning ?? false;
        }
        if (selector === CHANNEL_HEALTH_SELECTORS.liveContent) {
          return liveVisible;
        }
        throw new Error(`Unexpected locator probe: ${selector}`);
      },
      async click(): Promise<void> {
        await warningClick();
      },
      async waitFor(): Promise<void> {
        if (!liveVisible) {
          throw new Error('Live content is not visible');
        }
      },
    };

    return mockLocator as unknown as Locator;
  });

  return {
    page: {
      isClosed: () => false,
      url: () => TARGET_URL,
      evaluate,
      locator,
    } as unknown as Page,
    evaluate,
    locator,
    warningClick,
  };
}

describe('evaluateChannelHealth', () => {
  it('以單一 DOM snapshot 探測一般健康狀態', async () => {
    const mockPage = createPage({
      loginRequired: false,
      error: false,
      offline: false,
      liveContent: true,
      unsupportedPlayerError: false,
    });

    await expect(
      evaluateChannelHealth(mockPage.page, TARGET_URL),
    ).resolves.toEqual({ healthy: true, reason: 'live' });

    expect(mockPage.evaluate).toHaveBeenCalledOnce();
    expect(mockPage.locator).toHaveBeenCalledOnce();
    expect(mockPage.locator).toHaveBeenCalledWith(
      CHANNEL_HEALTH_SELECTORS.contentWarning,
    );
  });

  it('保留 login、error、offline、content warning、live 的判斷優先序', async () => {
    const loginPage = createPage({
      loginRequired: true,
      error: true,
      offline: true,
      liveContent: true,
      unsupportedPlayerError: true,
    });
    await expect(
      evaluateChannelHealth(loginPage.page, TARGET_URL),
    ).resolves.toEqual({ healthy: false, reason: 'login_required' });
    expect(loginPage.locator).not.toHaveBeenCalled();

    const errorPage = createPage({
      loginRequired: false,
      error: false,
      offline: true,
      liveContent: true,
      unsupportedPlayerError: true,
    });
    await expect(
      evaluateChannelHealth(errorPage.page, TARGET_URL),
    ).resolves.toEqual({ healthy: false, reason: 'error_page' });
    expect(errorPage.locator).not.toHaveBeenCalled();

    const offlinePage = createPage({
      loginRequired: false,
      error: false,
      offline: true,
      liveContent: true,
      unsupportedPlayerError: false,
    });
    await expect(
      evaluateChannelHealth(offlinePage.page, TARGET_URL),
    ).resolves.toEqual({ healthy: false, reason: 'offline' });
    expect(offlinePage.locator).not.toHaveBeenCalled();
  });

  it('一般未登入回報 login_missing，明確登入阻擋仍優先', async () => {
    const snapshot = {
      loginRequired: false,
      loggedOut: true,
      error: false,
      offline: false,
      liveContent: true,
      unsupportedPlayerError: false,
    };
    await expect(evaluateChannelHealth(createPage(snapshot).page, TARGET_URL))
      .resolves.toEqual({ healthy: false, reason: 'login_missing' });
    await expect(evaluateChannelHealth(createPage({ ...snapshot, loginRequired: true }).page, TARGET_URL))
      .resolves.toEqual({ healthy: false, reason: 'login_required' });
    await expect(evaluateChannelHealth(createPage({ ...snapshot, error: true }).page, TARGET_URL))
      .resolves.toEqual({ healthy: false, reason: 'error_page' });
    await expect(evaluateChannelHealth(createPage({ ...snapshot, liveContent: false }, { contentWarning: true }).page, TARGET_URL))
      .resolves.toEqual({ healthy: false, reason: 'login_missing' });
  });

  it('content warning 仍用 Locator 點擊並等待 live content', async () => {
    const mockPage = createPage(
      {
        loginRequired: false,
        error: false,
        offline: false,
        liveContent: false,
        unsupportedPlayerError: false,
      },
      { contentWarning: true },
    );

    await expect(
      evaluateChannelHealth(mockPage.page, TARGET_URL),
    ).resolves.toEqual({ healthy: true, reason: 'live' });

    expect(mockPage.evaluate).toHaveBeenCalledOnce();
    expect(mockPage.warningClick).toHaveBeenCalledOnce();
    expect(mockPage.locator).toHaveBeenCalledWith(
      CHANNEL_HEALTH_SELECTORS.liveContent,
    );
  });

  it('content warning 無法點擊時回報 content_warning', async () => {
    const mockPage = createPage(
      {
        loginRequired: false,
        error: false,
        offline: false,
        liveContent: false,
        unsupportedPlayerError: false,
      },
      {
        contentWarning: true,
        contentWarningClickError: new Error('button blocked'),
      },
    );

    await expect(
      evaluateChannelHealth(mockPage.page, TARGET_URL),
    ).resolves.toEqual({ healthy: false, reason: 'content_warning' });
  });
});
