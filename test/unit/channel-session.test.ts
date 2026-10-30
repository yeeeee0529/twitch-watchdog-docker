import type { Locator, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserManager } from '../../src/browser/BrowserManager.js';
import { COMMUNITY_POINTS_BALANCE_SELECTOR } from '../../src/browser/ChannelPointsReader.js';
import {
  CHANNEL_HEALTH_SELECTORS,
  DefaultChannelSession,
  DefaultChannelSessionFactory,
  REWARD_FAILURE_RECOVERY_THRESHOLD,
  createChannelUrl,
  evaluateChannelHealth,
  type ChannelHealthResult,
  type ChannelSessionLogger,
} from '../../src/browser/ChannelSession.js';
import type {
  RewardClaimer,
  RewardClaimResult,
} from '../../src/browser/RewardClaimer.js';
import type { AppConfig } from '../../src/config/AppConfig.js';
import { LOG_EVENTS } from '../../src/logging/index.js';
import { SIDE_NAV_TOGGLE_SELECTOR } from '../../src/browser/SideNavCollapser.js';
import {
  createDefaultBrowserRecovery,
  createDefaultBrowserSessionStart,
} from '../helpers/test-config.js';

type HealthMarker =
  | 'loginRequired'
  | 'liveContent'
  | 'error'
  | 'offline'
  | 'contentWarning';

interface MockPageControls {
  readonly page: Page;
  readonly setDefaultNavigationTimeout: ReturnType<typeof vi.fn>;
  readonly goto: ReturnType<typeof vi.fn>;
  readonly reload: ReturnType<typeof vi.fn>;
  readonly screenshot: ReturnType<typeof vi.fn>;
  readonly contentWarningClickCount: () => number;
  readonly sideNavCollapseClickCount: () => number;
  setMarker(marker: HealthMarker | undefined): void;
  setSideNavExpanded(expanded: boolean): void;
  setUrl(url: string): void;
  setClosed(closed: boolean): void;
  setChannelPointsBalance(balance: string | undefined): void;
}

const CHANNEL = 'streamer_one';
const TARGET_URL = `https://www.twitch.tv/${CHANNEL}`;
const NOW = new Date('2026-06-14T12:00:00.000Z');

function createConfig(
  overrides: Partial<AppConfig['browser']> = {},
): Pick<AppConfig, 'channels' | 'browser'> {
  return {
    channels: [CHANNEL],
    browser: {
      engine: overrides.engine ?? 'firefox',
      navigationTimeoutMs: overrides.navigationTimeoutMs ?? 30_000,
      pageHealthCheckIntervalSeconds:
        overrides.pageHealthCheckIntervalSeconds ?? 60,
      rewardCheckIntervalSeconds:
        overrides.rewardCheckIntervalSeconds ?? 30,
      pageRefreshIntervalSeconds:
        overrides.pageRefreshIntervalSeconds ?? 300,
      restartOnCrash: overrides.restartOnCrash ?? true,
      streamQuality: overrides.streamQuality ?? '160p',
      enforceStreamQualitySeconds:
        overrides.enforceStreamQualitySeconds ?? 120,
      viewportWidth: overrides.viewportWidth ?? 640,
      viewportHeight: overrides.viewportHeight ?? 360,
      muteAudio: overrides.muteAudio ?? true,
      blockImages: overrides.blockImages ?? true,
      blockFonts: overrides.blockFonts ?? true,
      blockKnownTracking: overrides.blockKnownTracking ?? false,
      disableChat: overrides.disableChat ?? true,
      resourceTelemetryIntervalSeconds:
        overrides.resourceTelemetryIntervalSeconds ?? 300,
      recovery:
        overrides.recovery ?? createDefaultBrowserRecovery(),
      sessionStart:
        overrides.sessionStart ?? createDefaultBrowserSessionStart(),
      resourceGuard:
        overrides.resourceGuard ??
        ({
          enabled: false,
          sampleIntervalSeconds: 2,
          startupRateGraceSeconds: 120,
          scaleWithStreams: true,
          baselineStreams: 3,
          baseMemoryMib: 512,
          warningMemoryMib: 4_096,
          warningResetMemoryMib: 3_840,
          browserRecycleMemoryMib: 4_608,
          browserRecycleConsecutiveSamples: 2,
          emergencyMemoryMib: 5_376,
          emergencySwapMib: 768,
          fastGrowthMib: 1_024,
          fastGrowthWindowSeconds: 30,
          postBrowserRestartRateGraceSeconds: 120,
          postRecycleObservationSeconds: 20,
          postRecycleTargetMemoryMib: 4_096,
          postRecycleMinimumDropMib: 512,
          effective: {
            maxConcurrentStreams: 1,
            warningMemoryMib: 4_096,
            warningResetMemoryMib: 3_840,
            browserRecycleMemoryMib: 4_608,
            emergencyMemoryMib: 5_376,
            postRecycleTargetMemoryMib: 4_096,
          },
        } as const),
    },
  };
}

function createMockPage(input: {
  readonly marker?: HealthMarker;
  readonly url?: string;
  readonly gotoError?: Error;
  readonly gotoImplementation?: () => Promise<null>;
  readonly finalUrl?: string;
  readonly reloadError?: Error;
  readonly reloadImplementation?: () => Promise<null>;
  readonly screenshotImplementation?: () => Promise<Buffer>;
  readonly contentWarningClickError?: Error;
  readonly sideNavExpanded?: boolean;
  readonly channelPointsBalance?: string;
} = {}): MockPageControls {
  let marker = input.marker;
  let currentUrl = input.url ?? 'about:blank';
  let closed = false;
  let channelPointsBalance = input.channelPointsBalance;
  let contentWarningClickCount = 0;
  let sideNavPresent = input.sideNavExpanded !== undefined;
  let sideNavExpanded = input.sideNavExpanded ?? false;
  let sideNavCollapseClickCount = 0;

  const locator = (selector: string): Locator => {
    const visible =
      (marker !== undefined && selector === CHANNEL_HEALTH_SELECTORS[marker]) ||
      (sideNavPresent && selector === SIDE_NAV_TOGGLE_SELECTOR);
    const mockLocator = {
      first(): Locator {
        return mockLocator as unknown as Locator;
      },
      async isVisible(): Promise<boolean> {
        return visible;
      },
      async click(): Promise<void> {
        if (selector === SIDE_NAV_TOGGLE_SELECTOR && sideNavExpanded) {
          sideNavExpanded = false;
          sideNavCollapseClickCount += 1;
          return;
        }
        if (
          marker === 'contentWarning' &&
          selector === CHANNEL_HEALTH_SELECTORS.contentWarning
        ) {
          if (input.contentWarningClickError !== undefined) {
            throw input.contentWarningClickError;
          }
          contentWarningClickCount += 1;
          marker = 'liveContent';
        }
      },
      async waitFor(): Promise<void> {
        if (!visible) {
          throw new Error('locator is not visible');
        }
      },
      async evaluate(): Promise<boolean> {
        return sideNavExpanded;
      },
      async evaluateAll(): Promise<readonly {
        readonly visible: boolean;
        readonly candidates: readonly string[];
      }[]> {
        if (
          selector === COMMUNITY_POINTS_BALANCE_SELECTOR &&
          channelPointsBalance !== undefined
        ) {
          return [{
            visible: true,
            candidates: [channelPointsBalance],
          }];
        }
        return [];
      },
    };
    return mockLocator as unknown as Locator;
  };

  const setDefaultNavigationTimeout = vi.fn();
  const goto = vi.fn(
    async (
      url: string,
      options?: { readonly signal?: AbortSignal },
    ): Promise<null> => {
      const signal = options?.signal;
      if (signal?.aborted === true) {
        throw new DOMException('Navigation aborted', 'AbortError');
      }
      if (input.gotoImplementation !== undefined) {
        await raceWithAbort(signal, input.gotoImplementation());
      }
      if (input.gotoError !== undefined) {
        throw input.gotoError;
      }
      currentUrl = input.finalUrl ?? url;
      return null;
    },
  );
  const reload = vi.fn(
    async (options?: { readonly signal?: AbortSignal }): Promise<null> => {
      const signal = options?.signal;
      if (signal?.aborted === true) {
        throw new DOMException('Navigation aborted', 'AbortError');
      }
      if (input.reloadImplementation !== undefined) {
        await raceWithAbort(signal, input.reloadImplementation());
      }
      if (input.reloadError !== undefined) {
        throw input.reloadError;
      }
      return null;
    },
  );
  const screenshot = vi.fn(async (): Promise<Buffer> => {
    if (input.screenshotImplementation !== undefined) {
      return input.screenshotImplementation();
    }
    return Buffer.from('png-image');
  });
  const evaluate = vi.fn(async () => ({
    loginRequired: marker === 'loginRequired',
    error: marker === 'error',
    offline: marker === 'offline',
    liveContent: marker === 'liveContent',
    unsupportedPlayerError: false,
  }));

  const page = {
    setDefaultNavigationTimeout,
    goto,
    reload,
    screenshot,
    evaluate,
    url: () => currentUrl,
    isClosed: () => closed,
    locator,
  } as unknown as Page;

  return {
    page,
    setDefaultNavigationTimeout,
    goto,
    reload,
    screenshot,
    contentWarningClickCount: () => contentWarningClickCount,
    sideNavCollapseClickCount: () => sideNavCollapseClickCount,
    setMarker(value): void {
      marker = value;
    },
    setSideNavExpanded(value): void {
      sideNavPresent = true;
      sideNavExpanded = value;
    },
    setUrl(value): void {
      currentUrl = value;
    },
    setClosed(value): void {
      closed = value;
    },
    setChannelPointsBalance(value): void {
      channelPointsBalance = value;
    },
  };
}

function createBrowserManager(page: Page): {
  readonly manager: BrowserManager;
  readonly createPage: ReturnType<typeof vi.fn>;
  readonly closePage: ReturnType<typeof vi.fn>;
} {
  const createPage = vi.fn(async () => page);
  const closePage = vi.fn(async () => undefined);
  return {
    manager: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      createPage,
      closePage,
      restart: vi.fn(async () => undefined),
      getPageCount: vi.fn(() => 1),
    },
    createPage,
    closePage,
  };
}

function createRewardClaimer(
  implementation: (
    page: Page,
    channel: string,
  ) => Promise<RewardClaimResult> = async (_page, channel) => ({
    status: 'not_found',
    channel,
    checkedAt: NOW.toISOString(),
  }),
): {
  readonly claimer: RewardClaimer;
  readonly claimIfAvailable: ReturnType<typeof vi.fn>;
  readonly hasClaimableBonus: ReturnType<typeof vi.fn>;
} {
  const claimIfAvailable = vi.fn(implementation);
  const hasClaimableBonus = vi.fn(async () => false);
  return {
    claimer: { claimIfAvailable, hasClaimableBonus },
    claimIfAvailable,
    hasClaimableBonus,
  };
}

function createLogger(): {
  readonly logger: ChannelSessionLogger;
  readonly debug: ReturnType<typeof vi.fn>;
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
} {
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return {
    logger: {
      debug,
      info,
      warn,
      error,
    },
    debug,
    info,
    warn,
    error,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value): void {
      resolvePromise?.(value);
    },
  };
}

async function raceWithAbort<T>(
  signal: AbortSignal | undefined,
  promise: Promise<T>,
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    throw new DOMException('Navigation aborted', 'AbortError');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('Navigation aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DefaultChannelSession', () => {
  it('併發 start 只建立一次 page、設定 timeout 並導覽編碼後 URL', async () => {
    const mockPage = createMockPage();
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig({ navigationTimeoutMs: 12_345 }),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });

    await Promise.all([session.start(), session.start(), session.start()]);

    expect(browser.createPage).toHaveBeenCalledOnce();
    expect(browser.createPage).toHaveBeenCalledWith(CHANNEL);
    expect(mockPage.setDefaultNavigationTimeout).toHaveBeenCalledWith(
      12_345,
    );
    expect(mockPage.goto).toHaveBeenCalledWith(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      signal: expect.any(AbortSignal),
    });
    expect(session.state).toBe('watching');

    await session.stop('test_complete');
    await Promise.all([session.start(), session.start()]);
    expect(browser.createPage).toHaveBeenCalledTimes(2);
    expect(session.state).toBe('watching');
    await session.stop('restart_complete');
  });

  it('start 失敗會透過 manager 清理 page 並進入 failed', async () => {
    const mockPage = createMockPage({
      gotoError: new Error('navigation failed'),
    });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });

    await expect(session.start()).rejects.toThrow('navigation failed');

    expect(browser.closePage).toHaveBeenCalledWith(CHANNEL);
    expect(session.state).toBe('failed');
  });

  it('取消進行中的 start 會 abort 底層 goto、關閉 page 並阻止 late success', async () => {
    const navigation = deferred<null>();
    const mockPage = createMockPage({
      gotoImplementation: () => navigation.promise,
    });
    const browser = createBrowserManager(mockPage.page);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
    });

    const startPromise = session.start();
    await vi.waitFor(() => {
      expect(mockPage.goto).toHaveBeenCalledOnce();
    });

    await session.cancelStart('start_timeout');
    expect(browser.closePage).toHaveBeenCalledWith(CHANNEL);

    navigation.resolve(null);
    await expect(startPromise).rejects.toThrow('Navigation aborted');
    expect(session.state).toBe('failed');
    expect(browser.closePage).toHaveBeenCalledTimes(2);
  });

  it('start 被取消時即使 goto 永不返回，abort 也會讓 start 立即結束且不留下 orphan page', async () => {
    const never = new Promise<null>(() => undefined);
    const mockPage = createMockPage({
      gotoImplementation: () => never,
    });
    const browser = createBrowserManager(mockPage.page);
    const logs = createLogger();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
      logger: logs.logger,
    });

    const startPromise = session.start();
    await vi.waitFor(() => {
      expect(mockPage.goto).toHaveBeenCalledOnce();
    });

    await session.cancelStart('start_timeout');

    await expect(startPromise).rejects.toThrow('Navigation aborted');
    expect(session.state).toBe('failed');
    expect(browser.closePage).toHaveBeenCalledWith(CHANNEL);
    expect(logs.debug).toHaveBeenCalledWith('watch_start_aborted', {
      channel: CHANNEL,
      reason: 'start_timeout',
      outcome: 'aborted',
      error: expect.stringMatching(/aborted/iu),
    });
  });

  it('start 導向非預期 origin 時立即關閉 page 且不啟動 session', async () => {
    const mockPage = createMockPage({
      finalUrl: 'https://example.test/fake-channel',
    });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });

    await expect(session.start()).rejects.toThrow('非預期 Twitch URL');
    expect(browser.closePage).toHaveBeenCalledWith(CHANNEL);
    expect(session.state).toBe('failed');
  });

  it('stop 可重複呼叫、關閉 page 並記錄停止原因', async () => {
    const mockPage = createMockPage();
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const logs = createLogger();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      logger: logs.logger,
    });
    await session.start();

    await Promise.all([
      session.stop('stream_offline'),
      session.stop('duplicate_stop'),
    ]);

    expect(browser.closePage).toHaveBeenCalledOnce();
    expect(session.state).toBe('stopped');
    expect(logs.info).toHaveBeenCalledWith(LOG_EVENTS.WATCH_STOPPED, {
      channel: CHANNEL,
      reason: 'stream_offline',
    });
  });

  it('正常 Twitch URL 且有播放器時為 healthy', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const logs = createLogger();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      logger: logs.logger,
    });
    await session.start();

    await expect(session.checkHealth()).resolves.toEqual({
      healthy: true,
      reason: 'live',
    });
    expect(session.state).toBe('watching');
    expect(logs.debug).toHaveBeenCalledWith(
      'session_maintenance_completed',
      expect.objectContaining({
        channel: CHANNEL,
        task: 'health',
        outcome: 'completed',
        queuedMs: expect.any(Number),
        durationMs: expect.any(Number),
      }),
    );

    await session.stop('test_complete');
    await session.checkHealth();
    expect(logs.debug).toHaveBeenCalledWith(
      'session_maintenance_skipped',
      {
        channel: CHANNEL,
        task: 'health',
        reason: 'page_missing',
      },
    );
  });

  it('start 遇到 Twitch 內容警示時會先按 Start Watching 再進入 watching', async () => {
    const mockPage = createMockPage({ marker: 'contentWarning' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const logs = createLogger();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      logger: logs.logger,
    });

    await session.start();

    expect(mockPage.contentWarningClickCount()).toBe(1);
    expect(session.state).toBe('watching');
    expect(logs.info).toHaveBeenCalledWith(
      'content_warning_accepted',
      {
        channel: CHANNEL,
        reason: 'start',
      },
    );

    await session.stop('test_complete');
  });

  it('start 與 reload 後會自動收合展開的 Twitch 左側欄', async () => {
    const mockPage = createMockPage({
      marker: 'liveContent',
      sideNavExpanded: true,
    });
    const browser = createBrowserManager(mockPage.page);
    const logs = createLogger();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
      logger: logs.logger,
    });

    await session.start();
    expect(mockPage.sideNavCollapseClickCount()).toBe(1);
    expect(logs.debug).toHaveBeenCalledWith('side_nav_collapsed', {
      channel: CHANNEL,
      reason: 'start',
    });

    mockPage.setSideNavExpanded(true);
    await session.refreshNow();
    expect(mockPage.sideNavCollapseClickCount()).toBe(2);
    expect(logs.debug).toHaveBeenCalledWith('side_nav_collapsed', {
      channel: CHANNEL,
      reason: 'manual_refresh',
    });

    await session.stop('test_complete');
  });

  it('觀看中可直接從現有 page 擷取 viewport PNG', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
    });
    await session.start();

    await expect(session.captureScreenshot()).resolves.toEqual(
      Buffer.from('png-image'),
    );
    expect(mockPage.screenshot).toHaveBeenCalledWith({
      type: 'png',
      fullPage: false,
    });

    await session.stop('test_complete');
    await expect(session.captureScreenshot()).rejects.toThrow(
      '頻道頁面目前無法截圖',
    );
  });

  it('captureScreenshot 會排在既有 page operation 後方', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const health = deferred<ChannelHealthResult>();
    const healthEvaluator = vi.fn(() => health.promise);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
      healthEvaluator,
    });
    await session.start();

    const healthPromise = session.checkHealth();
    await vi.waitFor(() => {
      expect(healthEvaluator).toHaveBeenCalledOnce();
    });
    const screenshotPromise = session.captureScreenshot();
    await Promise.resolve();
    expect(mockPage.screenshot).not.toHaveBeenCalled();

    health.resolve({ healthy: true, reason: 'live' });
    await healthPromise;
    await expect(screenshotPromise).resolves.toEqual(
      Buffer.from('png-image'),
    );
    expect(mockPage.screenshot).toHaveBeenCalledOnce();

    await session.stop('test_complete');
  });

  it('觀看中可讀取忠誠點數，停止後回報 page_unavailable', async () => {
    const mockPage = createMockPage({
      marker: 'liveContent',
      channelPointsBalance: '3,500',
    });
    const browser = createBrowserManager(mockPage.page);
    const logs = createLogger();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
      logger: logs.logger,
    });
    await session.start();

    await expect(session.getChannelPoints()).resolves.toEqual({
      status: 'available',
      balance: 3_500,
      displayValue: '3,500',
    });
    expect(logs.debug).toHaveBeenCalledWith(
      'session_maintenance_completed',
      expect.objectContaining({ task: 'points', outcome: 'completed' }),
    );

    await session.stop('test_complete');
    await expect(session.getChannelPoints()).resolves.toEqual({
      status: 'unavailable',
      reason: 'page_unavailable',
    });
  });

  it('讀取失敗且無可領取 bonus 時回傳原結果且不領取', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });
    await session.start();

    await expect(session.getChannelPoints()).resolves.toEqual({
      status: 'unavailable',
      reason: 'not_found',
    });
    expect(rewards.hasClaimableBonus).toHaveBeenCalledOnce();
    expect(rewards.claimIfAvailable).not.toHaveBeenCalled();

    await session.stop('test_complete');
  });

  it('hasClaimableBonus 檢查拋錯時視為不可領取', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    rewards.hasClaimableBonus.mockRejectedValueOnce(new Error('boom'));
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });
    await session.start();

    await expect(session.getChannelPoints()).resolves.toEqual({
      status: 'unavailable',
      reason: 'not_found',
    });
    expect(rewards.claimIfAvailable).not.toHaveBeenCalled();

    await session.stop('test_complete');
  });

  it('被 bonus 蓋住時先領取再重讀回傳餘額', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer(async (_page, channel) => {
      mockPage.setChannelPointsBalance('3,500');
      return {
        status: 'claimed',
        channel,
        claimedAt: NOW.toISOString(),
      };
    });
    rewards.hasClaimableBonus.mockResolvedValue(true);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      pointsClaimRetryAttempts: 1,
      pointsClaimRetryDelayMs: 1,
    });
    await session.start();

    await expect(session.getChannelPoints()).resolves.toEqual({
      status: 'available',
      balance: 3_500,
      displayValue: '3,500',
    });
    expect(rewards.hasClaimableBonus).toHaveBeenCalledOnce();
    expect(rewards.claimIfAvailable).toHaveBeenCalledOnce();
    expect(rewards.claimIfAvailable).toHaveBeenCalledWith(
      mockPage.page,
      CHANNEL,
    );

    await session.stop('test_complete');
  });

  it('領取後重讀仍失敗時回傳最後一次 unavailable', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer(async (_page, channel) => ({
      status: 'claimed',
      channel,
      claimedAt: NOW.toISOString(),
    }));
    rewards.hasClaimableBonus.mockResolvedValue(true);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      pointsClaimRetryAttempts: 2,
      pointsClaimRetryDelayMs: 1,
    });
    await session.start();

    await expect(session.getChannelPoints()).resolves.toEqual({
      status: 'unavailable',
      reason: 'not_found',
    });
    expect(rewards.claimIfAvailable).toHaveBeenCalledOnce();

    await session.stop('test_complete');
  });

  it('claim 拋錯時仍嘗試重讀餘額', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer(async () => {
      throw new Error('claim exploded');
    });
    rewards.hasClaimableBonus.mockResolvedValue(true);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      pointsClaimRetryAttempts: 1,
      pointsClaimRetryDelayMs: 1,
    });
    await session.start();

    await expect(session.getChannelPoints()).resolves.toEqual({
      status: 'unavailable',
      reason: 'not_found',
    });
    expect(rewards.claimIfAvailable).toHaveBeenCalledOnce();

    await session.stop('test_complete');
  });

  it.each([
    ['loginRequired', 'login_required'],
    ['error', 'error_page'],
    ['offline', 'offline'],
  ] as const)('明確辨識 %s 頁面', async (marker, reason) => {
    const mockPage = createMockPage({ marker });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });
    await session.start();

    await expect(session.checkHealth()).resolves.toEqual({
      healthy: false,
      reason,
    });

    await session.stop('test_complete');
  });

  it('健康檢查遇到可確認的 Twitch 內容警示時會按掉並回到 healthy', async () => {
    const mockPage = createMockPage({ marker: 'contentWarning' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });
    await session.start();
    mockPage.setMarker('contentWarning');

    await expect(session.checkHealth()).resolves.toEqual({
      healthy: true,
      reason: 'live',
    });
    expect(mockPage.contentWarningClickCount()).toBe(2);

    await session.stop('test_complete');
  });

  it('健康檢查遇到無法確認的 Twitch 內容警示時回報 content_warning', async () => {
    const mockPage = createMockPage({
      marker: 'contentWarning',
      url: TARGET_URL,
      contentWarningClickError: new Error('button blocked'),
    });

    await expect(
      evaluateChannelHealth(mockPage.page, TARGET_URL),
    ).resolves.toEqual({
      healthy: false,
      reason: 'content_warning',
    });
  });

  it('URL mismatch 與 page closed 回傳明確原因', async () => {
    const mismatchPage = createMockPage({ marker: 'liveContent' });
    mismatchPage.setUrl('https://www.twitch.tv/another_channel');
    await expect(
      evaluateChannelHealth(mismatchPage.page, TARGET_URL),
    ).resolves.toEqual({
      healthy: false,
      reason: 'url_mismatch',
    });

    mismatchPage.setClosed(true);
    await expect(
      evaluateChannelHealth(mismatchPage.page, TARGET_URL),
    ).resolves.toEqual({
      healthy: false,
      reason: 'page_closed',
    });
  });

  it('登入失敗不 reload，下一次健康才恢復 watching', async () => {
    const mockPage = createMockPage({ marker: 'loginRequired' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });
    await session.start();

    await expect(session.checkHealth()).resolves.toEqual({
      healthy: false,
      reason: 'login_required',
    });
    expect(mockPage.reload).not.toHaveBeenCalled();
    expect(session.state).toBe('recovering');

    mockPage.setMarker('liveContent');
    await expect(session.checkHealth()).resolves.toEqual({
      healthy: true,
      reason: 'live',
    });
    expect(session.state).toBe('watching');

    await session.stop('test_complete');
  });

  it.each(['login_required', 'login_missing'] as const)(
    '%s 不重整，仍在連續失敗門檻後關閉並通知失效',
    async (reason) => {
      const mockPage = createMockPage({ marker: 'liveContent' });
      const browser = createBrowserManager(mockPage.page);
      const onInvalidated = vi.fn(async () => undefined);
      const session = new DefaultChannelSession({
        channel: CHANNEL,
        config: createConfig(),
        browserManager: browser.manager,
        rewardClaimer: createRewardClaimer().claimer,
        healthEvaluator: async () => ({ healthy: false, reason }),
        onInvalidated,
      });
      await session.start();
      for (let check = 0; check < 3; check += 1) {
        await expect(session.checkHealth()).resolves.toEqual({ healthy: false, reason });
      }
      expect(mockPage.reload).not.toHaveBeenCalled();
      expect(browser.closePage).toHaveBeenCalledOnce();
      expect(session.state).toBe('failed');
      await vi.waitFor(() => {
        expect(onInvalidated).toHaveBeenCalledWith(CHANNEL, 'health_failure_threshold');
      });
    },
  );

  it('連續三次失敗後停止 timers、關閉 page 並進入 failed', async () => {
    const mockPage = createMockPage({ marker: 'offline' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const onInvalidated = vi.fn(async () => undefined);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      onInvalidated,
    });
    await session.start();

    await session.checkHealth();
    await session.checkHealth();
    await session.checkHealth();

    expect(mockPage.reload).toHaveBeenCalledOnce();
    expect(browser.closePage).toHaveBeenCalledOnce();
    expect(session.state).toBe('failed');
    await vi.waitFor(() => {
      expect(onInvalidated).toHaveBeenCalledWith(
        CHANNEL,
        'health_failure_threshold',
      );
    });
    await expect(session.checkHealth()).resolves.toEqual({
      healthy: false,
      reason: 'page_closed',
    });
  });

  it('reward click_failed 只回報結果，不停止 session', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer(async (_page, channel) => ({
      status: 'click_failed',
      channel,
      checkedAt: NOW.toISOString(),
      error: 'click failed',
    }));
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });
    await session.start();

    await expect(session.tickRewardClaim()).resolves.toMatchObject({
      status: 'click_failed',
    });
    expect(session.state).toBe('watching');
    expect(browser.closePage).not.toHaveBeenCalled();

    await session.stop('test_complete');
  });

  it('reward 連續失敗滿門檻時重整該頻道頁面', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer(async (_page, channel) => ({
      status: 'click_failed',
      channel,
      checkedAt: NOW.toISOString(),
      error: 'click failed',
    }));
    const logs = createLogger();
    const onPageRefresh = vi.fn(async () => undefined);
    const onContainerRestartRequested = vi.fn(async () => undefined);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      logger: logs.logger,
      onPageRefresh,
      onContainerRestartRequested,
      now: () => NOW,
    });
    await session.start();

    for (let index = 0; index < REWARD_FAILURE_RECOVERY_THRESHOLD; index += 1) {
      await expect(session.tickRewardClaim()).resolves.toMatchObject({
        status: 'click_failed',
      });
    }

    expect(mockPage.reload).toHaveBeenCalledOnce();
    expect(session.state).toBe('watching');
    expect(onContainerRestartRequested).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledWith(
      LOG_EVENTS.REWARD_CLAIM_FAILURE_THRESHOLD,
      expect.objectContaining({
        channel: CHANNEL,
        consecutiveFailures: REWARD_FAILURE_RECOVERY_THRESHOLD,
      }),
    );
    expect(logs.warn).toHaveBeenCalledWith(
      LOG_EVENTS.REWARD_CLAIM_FAILURE_RECOVERY_REFRESH,
      {
        channel: CHANNEL,
        threshold: REWARD_FAILURE_RECOVERY_THRESHOLD,
        reason: 'reward_claim_failure_threshold',
      },
    );
    await vi.waitFor(() => {
      expect(onPageRefresh).toHaveBeenCalledWith({
        channel: CHANNEL,
        reason: 'reward_claim_failure_threshold',
        startedAt: NOW.toISOString(),
      });
    });

    await session.stop('test_complete');
  });

  it('reward 重整後再次連續失敗會要求容器重啟', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer(async (_page, channel) => ({
      status: 'click_failed',
      channel,
      checkedAt: NOW.toISOString(),
      error: 'click failed',
    }));
    const logs = createLogger();
    const onContainerRestartRequested = vi.fn(async () => undefined);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      logger: logs.logger,
      onContainerRestartRequested,
      now: () => NOW,
    });
    await session.start();

    for (
      let index = 0;
      index < REWARD_FAILURE_RECOVERY_THRESHOLD * 2;
      index += 1
    ) {
      await session.tickRewardClaim();
    }
    await session.tickRewardClaim();

    expect(mockPage.reload).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(onContainerRestartRequested).toHaveBeenCalledOnce();
    });
    expect(onContainerRestartRequested).toHaveBeenCalledWith({
      channel: CHANNEL,
      reason: 'reward_claim_failure_after_refresh',
      consecutiveFailures: REWARD_FAILURE_RECOVERY_THRESHOLD,
      requestedAt: NOW.toISOString(),
    });
    // Canonical container_restart_requested is emitted by ContainerRestartController
    // (observer), not by the session itself when an observer is wired.
    expect(logs.error).not.toHaveBeenCalledWith(
      LOG_EVENTS.CONTAINER_RESTART_REQUESTED,
      expect.anything(),
    );

    await session.stop('test_complete');
  });

  it('reward 失敗後成功或 not_found 會重置復原狀態', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const outcomes: RewardClaimResult[] = [
      ...Array.from(
        { length: REWARD_FAILURE_RECOVERY_THRESHOLD - 1 },
        () => ({
          status: 'click_failed' as const,
          channel: CHANNEL,
          checkedAt: NOW.toISOString(),
          error: 'click failed',
        }),
      ),
      {
        status: 'not_found',
        channel: CHANNEL,
        checkedAt: NOW.toISOString(),
      },
      ...Array.from(
        { length: REWARD_FAILURE_RECOVERY_THRESHOLD - 1 },
        () => ({
          status: 'click_failed' as const,
          channel: CHANNEL,
          checkedAt: NOW.toISOString(),
          error: 'click failed',
        }),
      ),
      {
        status: 'claimed',
        channel: CHANNEL,
        claimedAt: NOW.toISOString(),
      },
    ];
    const rewards = createRewardClaimer(async () => {
      const next = outcomes.shift();
      if (next === undefined) {
        throw new Error('unexpected reward claim');
      }
      return next;
    });
    const onContainerRestartRequested = vi.fn(async () => undefined);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      onContainerRestartRequested,
    });
    await session.start();

    while (outcomes.length > 0) {
      await session.tickRewardClaim();
    }

    expect(mockPage.reload).not.toHaveBeenCalled();
    expect(onContainerRestartRequested).not.toHaveBeenCalled();

    await session.stop('test_complete');
  });

  it('獎勵操作前 URL 已偏離目標時不呼叫 RewardClaimer', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      now: () => NOW,
    });
    await session.start();
    mockPage.setUrl('https://example.test/fake-channel');

    await expect(session.tickRewardClaim()).resolves.toEqual({
      status: 'not_found',
      channel: CHANNEL,
      checkedAt: NOW.toISOString(),
    });
    expect(rewards.claimIfAvailable).not.toHaveBeenCalled();

    await session.stop('test_complete');
  });

  it('timer 工作不重入，且同一頁面的維護操作依序執行', async () => {
    vi.useFakeTimers();
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const health = deferred<ChannelHealthResult>();
    const reward = deferred<RewardClaimResult>();
    const healthEvaluator = vi.fn(() => health.promise);
    const rewards = createRewardClaimer(() => reward.promise);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig({
        pageHealthCheckIntervalSeconds: 1,
        rewardCheckIntervalSeconds: 1,
      }),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      healthEvaluator,
    });
    await session.start();

    vi.advanceTimersByTime(6_000);
    await vi.waitFor(() => {
      expect(healthEvaluator).toHaveBeenCalledOnce();
    });
    expect(rewards.claimIfAvailable).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(healthEvaluator).toHaveBeenCalledOnce();
    expect(rewards.claimIfAvailable).not.toHaveBeenCalled();

    health.resolve({ healthy: true, reason: 'live' });
    await vi.waitFor(() => {
      expect(rewards.claimIfAvailable).toHaveBeenCalledOnce();
    });

    const stopPromise = session.stop('shutdown');
    await Promise.resolve();
    expect(browser.closePage).not.toHaveBeenCalled();

    reward.resolve({
      status: 'not_found',
      channel: CHANNEL,
      checkedAt: NOW.toISOString(),
    });
    await expect(stopPromise).resolves.toBeUndefined();
    expect(browser.closePage).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(healthEvaluator).toHaveBeenCalledOnce();
    expect(rewards.claimIfAvailable).toHaveBeenCalledOnce();
  });

  it('依設定定時刷新頁面並在 reload 後維持 watching', async () => {
    vi.useFakeTimers();
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const logs = createLogger();
    const onPageRefresh = vi.fn(async () => undefined);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig({
        pageRefreshIntervalSeconds: 1,
      }),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      logger: logs.logger,
      onPageRefresh,
    });
    await session.start();

    expect(session.getRefreshStatus()).toMatchObject({
      channel: CHANNEL,
      enabled: true,
      secondsUntilRefresh: expect.any(Number),
      nextRefreshAt: expect.any(String),
    });

    vi.advanceTimersByTime(61_000);
    await Promise.resolve();
    await vi.waitFor(() => {
      expect(mockPage.reload).toHaveBeenCalledOnce();
    });

    expect(session.state).toBe('watching');
    await vi.waitFor(() => {
      expect(logs.info).toHaveBeenCalledWith('page_refreshed', {
        channel: CHANNEL,
        reason: 'scheduled_refresh',
      });
    });
    await vi.waitFor(() => {
      expect(onPageRefresh).toHaveBeenCalledWith({
        channel: CHANNEL,
        reason: 'scheduled_refresh',
        startedAt: expect.any(String),
      });
    });

    await session.stop('test_complete');
  });

  it('重整後遇到 Twitch 內容警示時會重新按 Start Watching', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
    });
    await session.start();

    mockPage.setMarker('contentWarning');
    await expect(session.refreshNow()).resolves.toBe(true);

    expect(mockPage.contentWarningClickCount()).toBe(1);
    await expect(session.checkHealth()).resolves.toEqual({
      healthy: true,
      reason: 'live',
    });

    await session.stop('test_complete');
  });

  it('page_refresh_interval_seconds 為 0 時不排程定時刷新', async () => {
    vi.useFakeTimers();
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig({
        pageRefreshIntervalSeconds: 0,
      }),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
    });
    await session.start();

    expect(session.getRefreshStatus()).toEqual({
      channel: CHANNEL,
      enabled: false,
    });

    vi.advanceTimersByTime(3_600_000);
    await Promise.resolve();

    expect(mockPage.reload).not.toHaveBeenCalled();
    await session.stop('test_complete');
  });

  it('refreshNow 會手動重整頁面並送出 manual_refresh 事件', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const onPageRefresh = vi.fn(async () => undefined);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
      onPageRefresh,
      now: () => NOW,
    });
    await session.start();

    await expect(session.refreshNow()).resolves.toBe(true);

    expect(mockPage.reload).toHaveBeenCalledOnce();
    expect(mockPage.reload).toHaveBeenCalledWith({
      waitUntil: 'domcontentloaded',
      signal: expect.any(AbortSignal),
    });
    await vi.waitFor(() => {
      expect(onPageRefresh).toHaveBeenCalledWith({
        channel: CHANNEL,
        reason: 'manual_refresh',
        startedAt: NOW.toISOString(),
      });
    });

    await session.stop('test_complete');
  });

  it('stop 會 abort 進行中的 reload 並快速完成清理', async () => {
    const reload = deferred<null>();
    const mockPage = createMockPage({
      marker: 'liveContent',
      reloadImplementation: () => reload.promise,
    });
    const browser = createBrowserManager(mockPage.page);
    const logs = createLogger();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
      logger: logs.logger,
    });
    await session.start();

    const refreshPromise = session.refreshNow();
    await vi.waitFor(() => {
      expect(mockPage.reload).toHaveBeenCalledOnce();
    });

    await expect(session.stop('shutdown')).resolves.toBeUndefined();
    expect(browser.closePage).toHaveBeenCalledOnce();
    expect(session.state).toBe('stopped');
    expect(logs.debug).toHaveBeenCalledWith('session_operation_aborted', {
      channel: CHANNEL,
      reason: 'shutdown',
      outcome: 'aborted',
    });

    reload.resolve(null);
    await expect(refreshPromise).rejects.toThrow('Navigation aborted');
  });

  it('stop 等待無法 abort 的 page operation 超時後會強制關閉 page', async () => {
    vi.useFakeTimers();
    const hang = new Promise<Buffer>(() => undefined);
    const mockPage = createMockPage({
      marker: 'liveContent',
      screenshotImplementation: () => hang,
    });
    const browser = createBrowserManager(mockPage.page);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: createRewardClaimer().claimer,
      pageOperationDrainTimeoutMs: 1_000,
    });
    await session.start();

    const screenshotPromise = session.captureScreenshot();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPage.screenshot).toHaveBeenCalledOnce();

    const stopPromise = session.stop('shutdown');
    await Promise.resolve();
    expect(browser.closePage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(browser.closePage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopPromise).resolves.toBeUndefined();
    expect(browser.closePage).toHaveBeenCalledOnce();
    expect(session.state).toBe('stopped');

    void screenshotPromise.catch(() => undefined);
  });

  it('RewardClaimer 拋錯時轉為 click_failed 且避免 timer rejection', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer(async () => {
      throw new Error('access_token=secret-value');
    });
    const logs = createLogger();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      logger: logs.logger,
      now: () => NOW,
    });
    await session.start();

    const result = await session.tickRewardClaim();

    expect(result.status).toBe('click_failed');
    if (result.status === 'click_failed') {
      expect(result.error).not.toContain('secret-value');
    }
    expect(session.state).toBe('watching');
    expect(logs.warn).toHaveBeenCalledWith(
      LOG_EVENTS.REWARD_CLAIM_FAILED,
      expect.objectContaining({ channel: CHANNEL }),
    );

    await session.stop('test_complete');
  });
});

describe('ChannelSession helpers and factory', () => {
  it('只接受設定模組已驗證且存在於 channels 的名稱', () => {
    const mockPage = createMockPage();
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const factory = new DefaultChannelSessionFactory({
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });

    expect(factory.create(CHANNEL).channel).toBe(CHANNEL);
    expect(() => factory.create('../escape')).toThrow(
      'Channel 必須是 1 到 25 字元的英數字或底線',
    );
    expect(() => factory.create('not_configured')).toThrow(
      '不在已驗證的設定清單中',
    );
  });

  it('createChannelUrl 使用 URL encoding 並拒絕不合法 channel', () => {
    expect(createChannelUrl('Valid_Channel')).toBe(
      'https://www.twitch.tv/Valid_Channel',
    );
    expect(() => createChannelUrl('invalid/channel')).toThrow();
  });
});
