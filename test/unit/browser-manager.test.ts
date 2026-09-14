import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  DefaultBrowserManager,
  type BrowserAdapter,
  type BrowserConsoleDiagnostic,
  type BrowserContextAdapter,
  type BrowserContextOptions,
  type BrowserHttpResponseDiagnostic,
  type BrowserInvalidation,
  type BrowserLaunchOptions,
  type BrowserLauncher,
  type BrowserManagerConfig,
  type BrowserManagerLogger,
  type BrowserPageAdapter,
  type BrowserRequestFailureDiagnostic,
} from '../../src/browser/BrowserManager.js';
import type { BrowserRecoveryConfig } from '../../src/config/AppConfig.js';

const STORAGE_STATE_PATH = '/private/credentials/storage-state.json';

function createConfig(
  overrides: Partial<{
    headless: boolean;
    restartOnCrash: boolean;
    disableChat: boolean;
    recovery: Partial<BrowserRecoveryConfig>;
  }> = {},
): BrowserManagerConfig {
  return {
    headless: overrides.headless ?? true,
    storageStatePath: STORAGE_STATE_PATH,
    browser: {
      restartOnCrash: overrides.restartOnCrash ?? true,
      viewportWidth: 1280,
      viewportHeight: 720,
      blockImages: false,
      blockFonts: false,
      blockKnownTracking: false,
      disableChat: overrides.disableChat ?? true,
      recovery: {
        pageCrashBackoffSeconds: [30, 60, 120],
        channelCrashWindowSeconds: 600,
        channelQuarantineThreshold: 4,
        channelQuarantineSeconds: 900,
        stableResetSeconds: 1_800,
        multiChannelCrashWindowSeconds: 15,
        multiChannelCrashThreshold: 2,
        browserFailureWindowSeconds: 600,
        browserFailureContainerThreshold: 3,
        ...overrides.recovery,
      },
    },
  };
}

function createLogger(): BrowserManagerLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

class MockPageAdapter implements BrowserPageAdapter {
  public readonly page: Page;
  public readonly close = vi.fn(async (): Promise<void> => {
    if (this.closeImplementation !== undefined) {
      await this.closeImplementation();
      return;
    }

    const failure = this.closeFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }

    this.closed = true;
    this.emit(this.closeListeners);
  });

  private closed = false;
  private readonly crashListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly popupListeners = new Set<(popup: Page) => void>();
  private readonly requestFailedListeners =
    new Set<(diagnostic: BrowserRequestFailureDiagnostic) => void>();
  private readonly responseListeners =
    new Set<(diagnostic: BrowserHttpResponseDiagnostic) => void>();
  private readonly consoleListeners =
    new Set<(diagnostic: BrowserConsoleDiagnostic) => void>();
  private readonly closeFailures: Error[] = [];
  public closeImplementation: (() => Promise<void>) | undefined;

  public constructor(public readonly name: string) {
    this.page = { mockPageName: name } as unknown as Page;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public onCrash(listener: () => void): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  public onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  public onPopup(listener: (popup: Page) => void): () => void {
    this.popupListeners.add(listener);
    return () => {
      this.popupListeners.delete(listener);
    };
  }

  public onRequestFailed(
    listener: (diagnostic: BrowserRequestFailureDiagnostic) => void,
  ): () => void {
    this.requestFailedListeners.add(listener);
    return () => {
      this.requestFailedListeners.delete(listener);
    };
  }

  public onResponse(
    listener: (diagnostic: BrowserHttpResponseDiagnostic) => void,
  ): () => void {
    this.responseListeners.add(listener);
    return () => {
      this.responseListeners.delete(listener);
    };
  }

  public onConsole(
    listener: (diagnostic: BrowserConsoleDiagnostic) => void,
  ): () => void {
    this.consoleListeners.add(listener);
    return () => {
      this.consoleListeners.delete(listener);
    };
  }

  public failNextClose(error = new Error('page close failed')): void {
    this.closeFailures.push(error);
  }

  public emitCrash(): void {
    this.emit(this.crashListeners);
  }

  public emitUnexpectedClose(): void {
    this.closed = true;
    this.emit(this.closeListeners);
  }

  public emitPopup(popup: Page): void {
    for (const listener of [...this.popupListeners]) {
      listener(popup);
    }
  }

  public emitRequestFailed(
    diagnostic: BrowserRequestFailureDiagnostic,
  ): void {
    for (const listener of [...this.requestFailedListeners]) {
      listener(diagnostic);
    }
  }

  public emitResponse(diagnostic: BrowserHttpResponseDiagnostic): void {
    for (const listener of [...this.responseListeners]) {
      listener(diagnostic);
    }
  }

  public emitConsole(diagnostic: BrowserConsoleDiagnostic): void {
    for (const listener of [...this.consoleListeners]) {
      listener(diagnostic);
    }
  }

  private emit(listeners: ReadonlySet<() => void>): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }
}

class MockContextAdapter implements BrowserContextAdapter {
  public readonly configureResourceBlocking = vi.fn(
    async (): Promise<void> => undefined,
  );
  public readonly configureChatBlocking = vi.fn(
    async (): Promise<void> => undefined,
  );
  public readonly newPage = vi.fn(async (): Promise<BrowserPageAdapter> => {
    if (this.newPageImplementation !== undefined) {
      return this.newPageImplementation();
    }

    const result = this.pageResults.shift();
    if (result instanceof Error) {
      throw result;
    }
    if (result !== undefined) {
      return result;
    }

    return new MockPageAdapter(`generated-${this.newPage.mock.calls.length}`);
  });

  public readonly close = vi.fn(async (): Promise<void> => {
    const failure = this.closeFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }
  });

  public newPageImplementation:
    | (() => Promise<BrowserPageAdapter>)
    | undefined;
  private readonly pageResults: Array<MockPageAdapter | Error>;
  private readonly closeFailures: Error[] = [];

  public constructor(pageResults: Array<MockPageAdapter | Error> = []) {
    this.pageResults = [...pageResults];
  }

  public failNextClose(error = new Error('context close failed')): void {
    this.closeFailures.push(error);
  }
}

class MockBrowserAdapter implements BrowserAdapter {
  public readonly newContext = vi.fn(
    async (options: BrowserContextOptions): Promise<BrowserContextAdapter> => {
      this.contextOptions.push(options);
      if (this.contextResult instanceof Error) {
        throw this.contextResult;
      }
      return this.contextResult;
    },
  );

  public readonly close = vi.fn(async (): Promise<void> => {
    if (this.closeImplementation !== undefined) {
      await this.closeImplementation();
      return;
    }
    const failure = this.closeFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    this.connected = false;
    this.emitDisconnected();
  });

  public readonly contextOptions: BrowserContextOptions[] = [];
  public closeImplementation: (() => Promise<void>) | undefined;
  private connected = true;
  private readonly disconnectedListeners = new Set<() => void>();
  private readonly closeFailures: Error[] = [];

  public constructor(
    private readonly contextResult: MockContextAdapter | Error,
  ) {}

  public isConnected(): boolean {
    return this.connected;
  }

  public getVersion(): string {
    return 'mock-browser-1.0';
  }

  public onDisconnected(listener: () => void): () => void {
    this.disconnectedListeners.add(listener);
    return () => {
      this.disconnectedListeners.delete(listener);
    };
  }

  public emitDisconnected(): void {
    this.connected = false;
    for (const listener of [...this.disconnectedListeners]) {
      listener();
    }
  }

  public failNextClose(error = new Error('browser close failed')): void {
    this.closeFailures.push(error);
  }
}

class MockLauncher implements BrowserLauncher {
  public readonly launch = vi.fn(
    async (options: BrowserLaunchOptions): Promise<BrowserAdapter> => {
      this.options.push(options);
      const result = this.results.shift();
      if (result instanceof Error) {
        throw result;
      }
      if (result === undefined) {
        throw new Error('測試未提供下一個 browser');
      }
      return result;
    },
  );

  public readonly options: BrowserLaunchOptions[] = [];

  public constructor(
    private readonly results: Array<MockBrowserAdapter | Error>,
  ) {}
}

describe('DefaultBrowserManager', () => {
  it('以 headless、storageState 與設定 viewport 啟動，重複 start 不重建', async () => {
    const context = new MockContextAdapter();
    const browser = new MockBrowserAdapter(context);
    const launcher = new MockLauncher([browser]);
    const manager = new DefaultBrowserManager(
      createConfig({ headless: false }),
      { launcher },
    );

    await Promise.all([manager.start(), manager.start()]);

    expect(launcher.launch).toHaveBeenCalledOnce();
    expect(launcher.options).toEqual([
      { headless: false },
    ]);
    expect(browser.contextOptions).toEqual([
      {
        storageState: STORAGE_STATE_PATH,
        viewport: { width: 1280, height: 720 },
      },
    ]);
    expect(context.configureResourceBlocking).toHaveBeenCalledWith({
      blockImages: false,
      blockFonts: false,
      blockKnownTracking: false,
    });
    expect(context.configureChatBlocking).toHaveBeenCalledWith(true);
    expect(manager.getBrowserVersion()).toBe('mock-browser-1.0');
    expect(manager.getBrowserGeneration()).toBe(1);
  });

  it('disableChat 設定為 false 時停用聊天封鎖', async () => {
    const context = new MockContextAdapter();
    const browser = new MockBrowserAdapter(context);
    const launcher = new MockLauncher([browser]);
    const manager = new DefaultBrowserManager(
      createConfig({ disableChat: false }),
      { launcher },
    );

    await manager.start();

    expect(context.configureChatBlocking).toHaveBeenCalledWith(false);
  });

  it('context 建立失敗時關閉 browser，之後可重新 start', async () => {
    const failedBrowser = new MockBrowserAdapter(
      new Error('context creation failed'),
    );
    const recoveredContext = new MockContextAdapter();
    const recoveredBrowser = new MockBrowserAdapter(recoveredContext);
    const launcher = new MockLauncher([failedBrowser, recoveredBrowser]);
    const manager = new DefaultBrowserManager(createConfig(), { launcher });

    await expect(manager.start()).rejects.toThrow('context creation failed');
    expect(failedBrowser.close).toHaveBeenCalledOnce();

    await manager.start();

    expect(launcher.launch).toHaveBeenCalledTimes(2);
    expect(recoveredBrowser.newContext).toHaveBeenCalledOnce();
  });

  it('未 start 時拒絕 createPage', async () => {
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([]),
    });

    await expect(manager.createPage('channel')).rejects.toThrow(
      'Browser Manager 尚未啟動',
    );
  });

  it('同一 channel 重複 createPage 回傳既有 page', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
    });
    await manager.start();

    const [first, second] = await Promise.all([
      manager.createPage('channel'),
      manager.createPage('channel'),
    ]);

    expect(first).toBe(page.page);
    expect(second).toBe(page.page);
    expect(context.newPage).toHaveBeenCalledOnce();
  });

  it('createPage 失敗不殘留 registry，下一次可重試', async () => {
    const recoveredPage = new MockPageAdapter('recovered');
    const context = new MockContextAdapter([
      new Error('new page failed'),
      recoveredPage,
    ]);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
    });
    await manager.start();

    await expect(manager.createPage('channel')).rejects.toThrow(
      'new page failed',
    );
    await expect(manager.createPage('channel')).resolves.toBe(
      recoveredPage.page,
    );
    expect(context.newPage).toHaveBeenCalledTimes(2);
  });

  it('closePage 可重複呼叫且正常關閉不通知 invalidation', async () => {
    const invalidations: BrowserInvalidation[] = [];
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
    });
    await manager.start();
    await manager.createPage('channel');

    await Promise.all([
      manager.closePage('channel'),
      manager.closePage('channel'),
    ]);

    expect(page.close).toHaveBeenCalledOnce();
    expect(invalidations).toEqual([]);
  });

  it('closePage 失敗時改為 full browser recycle，不在同 context 偷偷換 page', async () => {
    const page = new MockPageAdapter('channel');
    page.failNextClose();
    const firstContext = new MockContextAdapter([page]);
    const firstBrowser = new MockBrowserAdapter(firstContext);
    const secondContext = new MockContextAdapter();
    const secondBrowser = new MockBrowserAdapter(secondContext);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([firstBrowser, secondBrowser]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    await expect(manager.closePage('channel')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'browser_page_close_requires_recycle',
      expect.objectContaining({
        channel: 'channel',
        reason: 'page_close_failed',
      }),
    );

    await vi.waitFor(() => {
      expect(firstBrowser.close).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(secondBrowser.newContext).toHaveBeenCalled();
    });
    expect(manager.getPageCount()).toBe(0);
  });

  it('stop 關閉 pages、context、browser，併發與重複 stop 皆安全', async () => {
    const firstPage = new MockPageAdapter('first');
    const secondPage = new MockPageAdapter('second');
    const context = new MockContextAdapter([firstPage, secondPage]);
    const browser = new MockBrowserAdapter(context);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([browser]),
    });
    await manager.start();
    await manager.createPage('first');
    await manager.createPage('second');

    await Promise.all([manager.stop(), manager.stop()]);
    await manager.stop();

    expect(firstPage.close).toHaveBeenCalledOnce();
    expect(secondPage.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('stop 即使部分 close 失敗仍繼續清理其餘資源', async () => {
    const page = new MockPageAdapter('channel');
    page.failNextClose();
    const context = new MockContextAdapter([page]);
    context.failNextClose();
    const browser = new MockBrowserAdapter(context);
    browser.failNextClose();
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([browser]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    await expect(manager.stop()).resolves.toBeUndefined();

    expect(page.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('併發 manual restart 合併為一次並通知既有 channel 失效', async () => {
    const page = new MockPageAdapter('channel');
    const firstContext = new MockContextAdapter([page]);
    const firstBrowser = new MockBrowserAdapter(firstContext);
    const secondContext = new MockContextAdapter();
    const secondBrowser = new MockBrowserAdapter(secondContext);
    const launcher = new MockLauncher([firstBrowser, secondBrowser]);
    const logger = createLogger();
    const invalidations: BrowserInvalidation[] = [];
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
    });
    await manager.start();
    await manager.createPage('channel');

    await Promise.all([manager.restart(), manager.restart()]);

    expect(launcher.launch).toHaveBeenCalledTimes(2);
    expect(page.close).toHaveBeenCalledOnce();
    expect(firstContext.close).toHaveBeenCalledOnce();
    expect(firstBrowser.close).toHaveBeenCalledOnce();
    expect(invalidations).toEqual([
      { channel: 'channel', reason: 'browser_restarted' },
    ]);
    expect(logger.warn).toHaveBeenCalledWith('browser_restarted', {
      mode: 'manual',
      affectedChannelCount: 1,
      browserGeneration: 2,
    });
  });

  it('manual restart 啟動失敗時仍完成舊資源清理與失效通知', async () => {
    const page = new MockPageAdapter('channel');
    const firstContext = new MockContextAdapter([page]);
    const firstBrowser = new MockBrowserAdapter(firstContext);
    const launcher = new MockLauncher([
      firstBrowser,
      new Error('restart launch failed'),
    ]);
    const invalidations: BrowserInvalidation[] = [];
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
    });
    await manager.start();
    await manager.createPage('channel');

    await expect(manager.restart()).rejects.toThrow('restart launch failed');

    expect(page.close).toHaveBeenCalledOnce();
    expect(firstContext.close).toHaveBeenCalledOnce();
    expect(firstBrowser.close).toHaveBeenCalledOnce();
    expect(invalidations).toEqual([
      { channel: 'channel', reason: 'browser_restarted' },
    ]);
  });

  it('page crash 移除 registry、清理 page 並只通知一次', async () => {
    const crashedPage = new MockPageAdapter('crashed');
    const replacementPage = new MockPageAdapter('replacement');
    const context = new MockContextAdapter([crashedPage, replacementPage]);
    const invalidations: BrowserInvalidation[] = [];
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
    });
    await manager.start();
    await manager.createPage('channel');

    crashedPage.emitCrash();

    await vi.waitFor(() => {
      expect(invalidations).toEqual([
        { channel: 'channel', reason: 'page_crashed' },
      ]);
    });
    await expect(manager.createPage('channel')).resolves.toBe(
      replacementPage.page,
    );
    expect(crashedPage.close).toHaveBeenCalledOnce();
  });

  it('同一 normalized channel 重複 crash 不會 recycle browser', async () => {
    const firstPage = new MockPageAdapter('first');
    const secondPage = new MockPageAdapter('second');
    const context = new MockContextAdapter([firstPage, secondPage]);
    const launcher = new MockLauncher([new MockBrowserAdapter(context)]);
    const onInvalidated = vi.fn();
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      onInvalidated,
    });
    await manager.start();
    await manager.createPage('Same_Channel');
    await manager.createPage('same_channel');

    firstPage.emitCrash();
    secondPage.emitCrash();

    await vi.waitFor(() => {
      expect(onInvalidated).toHaveBeenCalledTimes(2);
    });
    expect(launcher.launch).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalledWith(
      'browser_crash_loop_recycle_requested',
      expect.anything(),
    );
  });

  it('15 秒內兩個不同 channel crash 只觸發同 generation 一次 recycle', async () => {
    const firstPage = new MockPageAdapter('first');
    const secondPage = new MockPageAdapter('second');
    const thirdPage = new MockPageAdapter('third');
    const firstBrowser = new MockBrowserAdapter(
      new MockContextAdapter([firstPage, secondPage, thirdPage]),
    );
    const recoveredBrowser = new MockBrowserAdapter(
      new MockContextAdapter(),
    );
    const launcher = new MockLauncher([firstBrowser, recoveredBrowser]);
    const logger = createLogger();
    const onFatalRecovery = vi.fn();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      onFatalRecovery,
    });
    await manager.start();
    await manager.createPage('First');
    await manager.createPage('SECOND');
    await manager.createPage('third');

    firstPage.emitCrash();
    secondPage.emitCrash();
    thirdPage.emitCrash();

    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(2);
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'browser_crash_loop_recycle_requested',
      {
        reason: 'multi_channel_page_crash',
        channel: 'SECOND',
        affectedChannels: ['first', 'second'],
        distinctChannelCount: 2,
        browserGeneration: 1,
        pageGeneration: 2,
      },
    );
    expect(
      vi.mocked(logger.warn).mock.calls.filter(
        ([event]) => event === 'browser_crash_loop_recycle_requested',
      ),
    ).toHaveLength(1);
    expect(onFatalRecovery).not.toHaveBeenCalled();
  });

  it('超出 multi-channel crash window 的不同 channel 不會 recycle', async () => {
    let clock = 0;
    const firstPage = new MockPageAdapter('first');
    const secondPage = new MockPageAdapter('second');
    const launcher = new MockLauncher([
      new MockBrowserAdapter(new MockContextAdapter([firstPage, secondPage])),
    ]);
    const onInvalidated = vi.fn();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      now: () => clock,
      onInvalidated,
    });
    await manager.start();
    await manager.createPage('first');
    await manager.createPage('second');

    firstPage.emitCrash();
    await vi.waitFor(() => {
      expect(onInvalidated).toHaveBeenCalledTimes(1);
    });
    clock = 15_001;
    secondPage.emitCrash();

    await vi.waitFor(() => {
      expect(onInvalidated).toHaveBeenCalledTimes(2);
    });
    expect(launcher.launch).toHaveBeenCalledOnce();
  });

  it('非預期 page close 通知失效且可重建相同 channel', async () => {
    const closedPage = new MockPageAdapter('closed');
    const replacementPage = new MockPageAdapter('replacement');
    const context = new MockContextAdapter([closedPage, replacementPage]);
    const onInvalidated = vi.fn();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      onInvalidated,
    });
    await manager.start();
    await manager.createPage('channel');

    closedPage.emitUnexpectedClose();

    await vi.waitFor(() => {
      expect(onInvalidated).toHaveBeenCalledWith({
        channel: 'channel',
        reason: 'page_closed',
      });
    });
    await expect(manager.createPage('channel')).resolves.toBe(
      replacementPage.page,
    );
    expect(closedPage.close).not.toHaveBeenCalled();
  });

  it('頁面 popup 立即關閉且不加入 channel registry', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    const popupClose = vi.fn(async () => undefined);
    const popup = {
      isClosed: () => false,
      close: popupClose,
    } as unknown as Page;
    await manager.start();
    await manager.createPage('channel');

    page.emitPopup(popup);

    await vi.waitFor(() => {
      expect(popupClose).toHaveBeenCalledOnce();
    });
    expect(logger.warn).toHaveBeenCalledWith('browser_popup_blocked', {
      channel: 'channel',
    });
    expect(context.newPage).toHaveBeenCalledOnce();
  });

  it('browser disconnect 通知全部 channel，並以 single-flight 退避重啟', async () => {
    const firstPage = new MockPageAdapter('first');
    const secondPage = new MockPageAdapter('second');
    const firstContext = new MockContextAdapter([firstPage, secondPage]);
    const firstBrowser = new MockBrowserAdapter(firstContext);
    const recoveredContext = new MockContextAdapter();
    const recoveredBrowser = new MockBrowserAdapter(recoveredContext);
    const launcher = new MockLauncher([firstBrowser, recoveredBrowser]);
    const sleep = vi.fn(async () => undefined);
    const invalidations: BrowserInvalidation[] = [];
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      sleep,
      restartBackoffMs: 25,
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
    });
    await manager.start();
    await manager.createPage('first');
    await manager.createPage('second');

    firstBrowser.emitDisconnected();
    firstBrowser.emitDisconnected();

    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(2);
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(25);
    expect(invalidations).toEqual([
      { channel: 'first', reason: 'browser_disconnected' },
      { channel: 'second', reason: 'browser_disconnected' },
    ]);
    expect(firstPage.close).toHaveBeenCalledOnce();
    expect(secondPage.close).toHaveBeenCalledOnce();
    expect(firstContext.close).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('browser_restarted', {
      mode: 'automatic',
      attempt: 1,
      browserGeneration: 2,
    });
  });

  it('page close 先清除 registry 時 disconnect 仍回報 generation snapshot', async () => {
    const page = new MockPageAdapter('channel');
    const firstBrowser = new MockBrowserAdapter(
      new MockContextAdapter([page]),
    );
    const recoveredBrowser = new MockBrowserAdapter(
      new MockContextAdapter(),
    );
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([firstBrowser, recoveredBrowser]),
      logger,
      sleep: async () => undefined,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitUnexpectedClose();
    await vi.waitFor(() => {
      expect(manager.getPageCount()).toBe(0);
    });
    firstBrowser.emitDisconnected();

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith('browser_disconnected', {
        affectedChannels: ['channel'],
        affectedChannelCount: 1,
        browserGeneration: 1,
      });
    });
  });

  it('restartOnCrash=false 時只清理與通知，不自動重啟', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const browser = new MockBrowserAdapter(context);
    const launcher = new MockLauncher([browser]);
    const onInvalidated = vi.fn();
    const manager = new DefaultBrowserManager(
      createConfig({ restartOnCrash: false }),
      { launcher, onInvalidated },
    );
    await manager.start();
    await manager.createPage('channel');

    browser.emitDisconnected();

    await vi.waitFor(() => {
      expect(onInvalidated).toHaveBeenCalledWith({
        channel: 'channel',
        reason: 'browser_disconnected',
      });
    });
    expect(launcher.launch).toHaveBeenCalledOnce();
  });

  it('自動重啟退避期間 stop 會取消後續復原', async () => {
    const browser = new MockBrowserAdapter(new MockContextAdapter());
    const recoveredBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([browser, recoveredBrowser]);
    const sleepGate = createDeferred<void>();
    const sleep = vi.fn(() => sleepGate.promise);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      sleep,
    });
    await manager.start();

    browser.emitDisconnected();
    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalledOnce();
    });
    await manager.stop();
    sleepGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(launcher.launch).toHaveBeenCalledOnce();
  });

  it('新的 browser crash 會取代仍在等待的過期復原排程', async () => {
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const secondBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const recoveredBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([
      firstBrowser,
      secondBrowser,
      recoveredBrowser,
    ]);
    const firstSleepGate = createDeferred<void>();
    let sleepCallCount = 0;
    const sleep = vi.fn(() => {
      sleepCallCount += 1;
      return sleepCallCount === 1
        ? firstSleepGate.promise
        : Promise.resolve();
    });
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      sleep,
    });
    await manager.start();

    firstBrowser.emitDisconnected();
    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalledOnce();
    });
    await manager.start();
    secondBrowser.emitDisconnected();

    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(3);
    });
    firstSleepGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(launcher.launch).toHaveBeenCalledTimes(3);
  });

  it('自動重啟失敗只嘗試一次，且不洩漏 storageState path', async () => {
    const context = new MockContextAdapter();
    const browser = new MockBrowserAdapter(context);
    const restartError = new Error(
      `storageState=${STORAGE_STATE_PATH} storageState={"cookies":[{"value":"secret-cookie"}]}`,
    );
    const launcher = new MockLauncher([browser, restartError]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      sleep: async () => undefined,
      maxAutomaticRestartAttempts: 1,
    });
    await manager.start();

    browser.emitDisconnected();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        'browser_restart_failed',
        expect.objectContaining({ mode: 'automatic', attempt: 1 }),
      );
    });
    await Promise.resolve();
    expect(launcher.launch).toHaveBeenCalledTimes(2);
    const serializedLogs = JSON.stringify({
      warn: vi.mocked(logger.warn).mock.calls,
      error: vi.mocked(logger.error).mock.calls,
    });
    expect(serializedLogs).not.toContain(STORAGE_STATE_PATH);
    expect(serializedLogs).not.toContain('secret-cookie');
  });

  it('自動重啟第一次失敗後以遞增退避再次嘗試', async () => {
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const recoveredBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([
      firstBrowser,
      new Error('first restart failed'),
      recoveredBrowser,
    ]);
    const logger = createLogger();
    const sleep = vi.fn(async () => undefined);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      sleep,
      restartBackoffMs: 25,
      maxAutomaticRestartAttempts: 2,
    });
    await manager.start();

    firstBrowser.emitDisconnected();

    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(3);
    });
    expect(sleep.mock.calls).toEqual([[25], [50]]);
    expect(logger.error).toHaveBeenCalledWith(
      'browser_restart_failed',
      expect.objectContaining({ mode: 'automatic', attempt: 1 }),
    );
    expect(logger.warn).toHaveBeenCalledWith('browser_restarted', {
      mode: 'automatic',
      attempt: 2,
      browserGeneration: 2,
    });
  });

  it('快速連續 browser crash 達上限後停止自動重啟', async () => {
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const secondBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const thirdBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([
      firstBrowser,
      secondBrowser,
      thirdBrowser,
    ]);
    const logger = createLogger();
    const onFatalRecovery = vi.fn();
    const manager = new DefaultBrowserManager(createConfig({
      recovery: { browserFailureContainerThreshold: 10 },
    }), {
      launcher,
      logger,
      sleep: async () => undefined,
      now: () => 1_000,
      maxAutomaticRestartAttempts: 2,
      // Keep crash-loop breaker high so this test isolates launch-attempt limit.
      onFatalRecovery,
    });
    await manager.start();

    firstBrowser.emitDisconnected();
    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(2);
    });
    secondBrowser.emitDisconnected();
    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(3);
    });
    thirdBrowser.emitDisconnected();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        'browser_restart_limit_reached',
        { maxAttempts: 2 },
      );
    });
    expect(onFatalRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'automatic_restart_limit_reached',
      }),
    );
    expect(launcher.launch).toHaveBeenCalledTimes(3);
  });

  it('invalidation observer 拋錯不阻塞 page 清理與重建', async () => {
    const failedPage = new MockPageAdapter('failed');
    const replacementPage = new MockPageAdapter('replacement');
    const context = new MockContextAdapter([failedPage, replacementPage]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
      onInvalidated: async () => {
        throw new Error('observer failed');
      },
    });
    await manager.start();
    await manager.createPage('channel');

    failedPage.emitCrash();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        'browser_invalidation_observer_failed',
        expect.objectContaining({
          channel: 'channel',
          reason: 'page_crashed',
        }),
      );
    });
    await expect(manager.createPage('channel')).resolves.toBe(
      replacementPage.page,
    );
  });

  it('page close 卡住時會 timeout 並排程 full browser recycle，不可同 context 重建', async () => {
    vi.useFakeTimers();
    const failedPage = new MockPageAdapter('failed');
    failedPage.closeImplementation = () =>
      new Promise<void>(() => undefined);
    const firstContext = new MockContextAdapter([failedPage]);
    const firstBrowser = new MockBrowserAdapter(firstContext);
    const replacementPage = new MockPageAdapter('replacement');
    const secondContext = new MockContextAdapter([replacementPage]);
    const secondBrowser = new MockBrowserAdapter(secondContext);
    const logger = createLogger();
    const invalidations: BrowserInvalidation[] = [];
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([firstBrowser, secondBrowser]),
      logger,
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
      resourceCloseTimeoutMs: 100,
    });
    await manager.start();
    await manager.createPage('channel');

    const closePage = manager.closePage('channel');
    await vi.advanceTimersByTimeAsync(100);
    await expect(closePage).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'browser_page_close_timeout',
      {
        channel: 'channel',
        phase: 'close',
        timeoutMs: 100,
      },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'browser_page_close_requires_recycle',
      expect.objectContaining({
        channel: 'channel',
        reason: 'page_close_timeout',
      }),
    );

    // Full recycle closes the old browser and launches a replacement.
    await vi.waitFor(() => {
      expect(firstBrowser.close).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(manager.getPageCount()).toBe(0);
    });

    // After recycle, a new page may be created on the new browser/context.
    // The timed-out page was already removed before recycle, so restart may
    // notify zero channels; createPage on the replacement browser is the signal.
    await expect(manager.createPage('channel')).resolves.toBe(
      replacementPage.page,
    );
    expect(secondContext.newPage).toHaveBeenCalled();
    expect(firstBrowser.close).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('browser close 無法確認終止時不 launch 替換 browser 並要求 fatal recovery', async () => {
    vi.useFakeTimers();
    const context = new MockContextAdapter([new MockPageAdapter('page')]);
    const hungBrowser = new MockBrowserAdapter(context);
    hungBrowser.closeImplementation = () =>
      new Promise<void>(() => undefined);
    const onFatalRecovery = vi.fn();
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([hungBrowser]),
      logger,
      onFatalRecovery,
      resourceCloseTimeoutMs: 50,
    });
    await manager.start();
    await manager.createPage('channel');

    const restartPromise = manager.restart();
    await vi.advanceTimersByTimeAsync(50);
    await expect(restartPromise).rejects.toThrow(/termination was not confirmed/i);

    expect(onFatalRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'browser_termination_unconfirmed' }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'browser_termination_unconfirmed',
      expect.objectContaining({ mode: 'manual' }),
    );

    vi.useRealTimers();
  });

  it('自動重啟次數耗盡時要求 container restart', async () => {
    vi.useFakeTimers();
    const first = new MockBrowserAdapter(new MockContextAdapter());
    const second = new MockBrowserAdapter(new MockContextAdapter());
    const third = new MockBrowserAdapter(new MockContextAdapter());
    const onFatalRecovery = vi.fn();
    const logger = createLogger();
    const launcher = new MockLauncher([first, second, third]);
    const manager = new DefaultBrowserManager(createConfig({
      recovery: { browserFailureContainerThreshold: 10 },
    }), {
      launcher,
      logger,
      onFatalRecovery,
      maxAutomaticRestartAttempts: 2,
      restartBackoffMs: 1,
      restartBackoffMaxMs: 1,
      restartAttemptResetMs: 60_000,
    });
    await manager.start();

    first.emitDisconnected();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(2);
    });
    second.emitDisconnected();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(3);
    });
    third.emitDisconnected();
    await vi.advanceTimersByTimeAsync(1);

    await vi.waitFor(() => {
      expect(onFatalRecovery).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'automatic_restart_limit_reached',
        }),
      );
    });
    expect(logger.error).toHaveBeenCalledWith(
      'browser_restart_limit_reached',
      { maxAttempts: 2 },
    );

    vi.useRealTimers();
  });

  it('短時間多次 unexpected browser disconnect 會以 crash-loop 要求 container restart', async () => {
    let clock = 0;
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const secondBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const thirdBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const onFatalRecovery = vi.fn();
    const launcher = new MockLauncher([
      firstBrowser,
      secondBrowser,
      thirdBrowser,
    ]);
    const manager = new DefaultBrowserManager(createConfig({
      recovery: {
        browserFailureContainerThreshold: 3,
        browserFailureWindowSeconds: 60,
      },
    }), {
      launcher,
      logger: createLogger(),
      sleep: async () => undefined,
      now: () => clock,
      maxAutomaticRestartAttempts: 10,
      onFatalRecovery,
    });
    await manager.start();
    expect(launcher.launch).toHaveBeenCalledTimes(1);

    clock = 1_000;
    firstBrowser.emitDisconnected();
    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(2);
    });

    clock = 2_000;
    secondBrowser.emitDisconnected();
    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(3);
    });

    clock = 3_000;
    thirdBrowser.emitDisconnected();
    await vi.waitFor(() => {
      expect(onFatalRecovery).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'browser_crash_loop' }),
      );
    });
    // Third disconnect escalates without another launch.
    expect(launcher.launch).toHaveBeenCalledTimes(3);
  });

  it('同一 channel 重複導覽逾時只記錄 per-channel diagnostic', async () => {
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const secondBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([firstBrowser, secondBrowser]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
    });
    await manager.start();

    await manager.reportNavigationOutcomes([
      { channel: 'channel', status: 'timed_out' },
    ]);

    expect(launcher.launch).toHaveBeenCalledOnce();

    await manager.reportNavigationOutcomes([
      { channel: 'channel', status: 'timed_out' },
    ]);

    expect(launcher.launch).toHaveBeenCalledOnce();
    expect(firstBrowser.close).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenLastCalledWith(
      'browser_navigation_failure_recorded',
      {
        channel: 'channel',
        status: 'timed_out',
        recovery: 'per_channel',
        browserGeneration: 1,
      },
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      'browser_navigation_failure_recycle_requested',
      expect.anything(),
    );
  });

  it('成功導覽與後續 timeout 都不會建立 browser-level breaker', async () => {
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const secondBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([firstBrowser, secondBrowser]);
    const manager = new DefaultBrowserManager(createConfig(), { launcher });
    await manager.start();

    await manager.reportNavigationOutcomes([
      { channel: 'channel', status: 'timed_out' },
    ]);
    await manager.reportNavigationOutcomes([
      { channel: 'channel', status: 'succeeded' },
    ]);
    await manager.reportNavigationOutcomes([
      { channel: 'channel', status: 'timed_out' },
    ]);

    expect(launcher.launch).toHaveBeenCalledOnce();

    await manager.reportNavigationOutcomes([
      { channel: 'channel', status: 'timed_out' },
    ]);

    expect(launcher.launch).toHaveBeenCalledOnce();
  });

  it('不同 channel 的導覽逾時也不會回收 browser', async () => {
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const secondBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([firstBrowser, secondBrowser]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
    });
    await manager.start();

    await manager.reportNavigationOutcomes([
      { channel: 'first', status: 'timed_out' },
      { channel: 'second', status: 'timed_out' },
      { channel: 'third', status: 'timed_out' },
    ]);

    expect(launcher.launch).toHaveBeenCalledOnce();
    expect(logger.debug).toHaveBeenCalledTimes(3);
    expect(logger.warn).not.toHaveBeenCalledWith(
      'browser_navigation_failure_recycle_requested',
      expect.anything(),
    );
  });

  it('不同時間的導覽逾時不會累積 browser-level recovery', async () => {
    let clock = 0;
    const browser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([browser]);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      now: () => clock,
    });
    await manager.start();

    await manager.reportNavigationOutcomes([
      { channel: 'channel', status: 'timed_out' },
    ]);
    clock = 5 * 60_000 + 1;
    await manager.reportNavigationOutcomes([
      { channel: 'channel', status: 'timed_out' },
    ]);

    expect(launcher.launch).toHaveBeenCalledOnce();
  });

  it('回收後忽略舊 recovery epoch 排隊中的 navigation outcome', async () => {
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const secondBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([firstBrowser, secondBrowser]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
    });
    await manager.start();
    await manager.reportNavigationOutcomes([
      { channel: 'channel', status: 'timed_out' },
    ]);

    const recycle = manager.restart();
    const staleBatch = manager.reportNavigationOutcomes([
      { channel: 'first', status: 'timed_out' },
      { channel: 'second', status: 'timed_out' },
      { channel: 'third', status: 'timed_out' },
    ]);
    await Promise.all([recycle, staleBatch]);

    expect(launcher.launch).toHaveBeenCalledTimes(2);
    expect(logger.debug).not.toHaveBeenCalledWith(
      'browser_navigation_failure_recorded',
      expect.objectContaining({ channel: 'first' }),
    );
  });

  it('大量 navigation timeout 不會要求 container restart', async () => {
    let clock = 0;
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const secondBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const thirdBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([
      firstBrowser,
      secondBrowser,
      thirdBrowser,
    ]);
    const onFatalRecovery = vi.fn();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      now: () => clock,
      onFatalRecovery,
    });
    await manager.start();

    for (let recovery = 1; recovery <= 3; recovery += 1) {
      clock = recovery * 1_000;
      await manager.reportNavigationOutcomes([
        { channel: 'channel', status: 'timed_out' },
      ]);
      await manager.reportNavigationOutcomes([
        { channel: 'channel', status: 'timed_out' },
      ]);
    }

    expect(onFatalRecovery).not.toHaveBeenCalled();
    expect(launcher.launch).toHaveBeenCalledOnce();
  });

  it('createPage 進行中呼叫 stop 時會等待建立完成後再清理', async () => {
    const page = new MockPageAdapter('delayed');
    const context = new MockContextAdapter();
    const deferred = createDeferred<BrowserPageAdapter>();
    context.newPageImplementation = () => deferred.promise;
    const browser = new MockBrowserAdapter(context);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([browser]),
    });
    await manager.start();

    const createPromise = manager.createPage('channel');
    const stopPromise = manager.stop();
    deferred.resolve(page);

    await expect(createPromise).resolves.toBe(page.page);
    await stopPromise;

    expect(page.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('request failed 記錄含 channel 與 generation 的消毒後端點資訊', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitRequestFailed({
      url: 'https://static.twitchcdn.net/assets/main.js?token=super-secret&challenge=abc',
      method: 'GET',
      resourceType: 'script',
      failureText: 'net::ERR_ABORTED',
    });

    expect(logger.debug).toHaveBeenCalledWith('browser_request_failed', {
      channel: 'channel',
      browserGeneration: 1,
      pageGeneration: 1,
      endpointCategory: 'twitch_javascript',
      host: 'static.twitchcdn.net',
      path: '/assets/main.js',
      method: 'GET',
      resourceType: 'script',
      failureText: 'net::ERR_ABORTED',
    });
    const serialized = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('challenge=abc');
  });

  it('GraphQL request failed 記錄 operationName 但不記錄 body', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitRequestFailed({
      url: 'https://gql.twitch.tv/gql?client_id=secret',
      method: 'POST',
      resourceType: 'fetch',
      failureText: 'net::ERR_FAILED',
      graphQlOperationNames: ['PlaybackAccessToken'],
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'browser_request_failed',
      expect.objectContaining({
        channel: 'channel',
        endpointCategory: 'twitch_graphql',
        host: 'gql.twitch.tv',
        path: '/gql',
        method: 'POST',
        resourceType: 'fetch',
        graphQlOperationNames: ['PlaybackAccessToken'],
      }),
    );
  });

  it('third_party request failed 以 debug 記錄', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitRequestFailed({
      url: 'https://spade.twitch.tv/track',
      method: 'POST',
      resourceType: 'xhr',
      failureText: 'net::ERR_CONNECTION_REFUSED',
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'browser_request_failed',
      expect.objectContaining({
        channel: 'channel',
        endpointCategory: 'twitch_other',
        host: 'spade.twitch.tv',
        path: '/track',
        method: 'POST',
        resourceType: 'xhr',
        failureText: 'net::ERR_CONNECTION_REFUSED',
      }),
    );
  });

  it('twitch_media ERR_ABORTED request failed 以 debug 記錄', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitRequestFailed({
      url: 'https://video-weaver.atl01.hls.ttvnw.net/v1/segment/part.ts',
      method: 'GET',
      resourceType: 'fetch',
      failureText: 'net::ERR_ABORTED',
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'browser_request_failed',
      expect.objectContaining({
        channel: 'channel',
        endpointCategory: 'twitch_media',
        host: 'video-weaver.atl01.hls.ttvnw.net',
        failureText: 'net::ERR_ABORTED',
      }),
    );
  });

  it('5xx 回應以 warn 記錄', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitResponse({
      url: 'https://static.twitchcdn.net/assets/loader.js',
      method: 'GET',
      resourceType: 'script',
      status: 503,
      statusText: 'Service Unavailable',
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'browser_http_response',
      expect.objectContaining({
        channel: 'channel',
        endpointCategory: 'twitch_javascript',
        httpStatus: 503,
        statusText: 'Service Unavailable',
      }),
    );
  });

  it('4xx document 回應以 warn 記錄', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitResponse({
      url: 'https://www.twitch.tv/some_channel',
      method: 'GET',
      resourceType: 'document',
      status: 404,
      statusText: 'Not Found',
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'browser_http_response',
      expect.objectContaining({
        channel: 'channel',
        endpointCategory: 'twitch_document',
        httpStatus: 404,
      }),
    );
  });

  it('非相關的 4xx 與成功的 media/圖片不記錄', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitResponse({
      url: 'https://video-weaver.atl01.hls.ttvnw.net/v1/playlist/segment.ts',
      method: 'GET',
      resourceType: 'fetch',
      status: 403,
      statusText: 'Forbidden',
    });
    page.emitResponse({
      url: 'https://analytics.example.com/track',
      method: 'POST',
      resourceType: 'fetch',
      status: 200,
      statusText: 'OK',
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('成功的 Twitch bootstrap 回應以 debug 記錄', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitResponse({
      url: 'https://gql.twitch.tv/gql',
      method: 'POST',
      resourceType: 'fetch',
      status: 200,
      statusText: 'OK',
      graphQlOperationNames: ['PlaybackAccessToken'],
    });

    expect(logger.debug).toHaveBeenCalledWith(
      'browser_http_response',
      expect.objectContaining({
        channel: 'channel',
        endpointCategory: 'twitch_graphql',
        httpStatus: 200,
        graphQlOperationNames: ['PlaybackAccessToken'],
      }),
    );
  });

  it('console error 對應 warn、warning 對應 debug、log 不記錄', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitConsole({
      type: 'error',
      text: 'Failed to load resource: token=abc',
      sourceUrl: 'https://static.twitchcdn.net/app.js?secret=1',
      lineNumber: 12,
      columnNumber: 4,
    });
    page.emitConsole({
      type: 'warning',
      text: 'Deprecated API usage',
      sourceUrl: 'https://static.twitchcdn.net/legacy.js',
      lineNumber: 7,
      columnNumber: 2,
    });
    page.emitConsole({ type: 'log', text: 'ordinary log' });

    expect(logger.warn).toHaveBeenCalledWith(
      'browser_console_message',
      expect.objectContaining({
        channel: 'channel',
        consoleType: 'error',
        message: 'Failed to load resource: token=abc',
        sourceHost: 'static.twitchcdn.net',
        sourcePath: '/app.js',
        lineNumber: 12,
        columnNumber: 4,
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'browser_console_message',
      expect.objectContaining({
        channel: 'channel',
        consoleType: 'warning',
        message: 'Deprecated API usage',
        sourceHost: 'static.twitchcdn.net',
        sourcePath: '/legacy.js',
      }),
    );
    const serialized = JSON.stringify({
      warn: vi.mocked(logger.warn).mock.calls,
      debug: vi.mocked(logger.debug).mock.calls,
    });
    expect(serialized).not.toContain('secret=1');
    expect(serialized).not.toContain('ordinary log');
  });

  it('third_party 來源的 console error 與已知噪音 pattern 以 debug 記錄', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    page.emitConsole({
      type: 'error',
      text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED',
      sourceUrl: 'https://sb.scorecardresearch.com/p',
    });
    page.emitConsole({
      type: 'error',
      text: 'SpadeClient send error -1 : Failed to fetch',
      sourceUrl: 'https://assets.twitch.tv/amazon-ivs-wasmworker.js',
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'browser_console_message',
      expect.objectContaining({
        channel: 'channel',
        consoleType: 'error',
        message: 'Failed to load resource: net::ERR_CONNECTION_REFUSED',
        sourceHost: 'sb.scorecardresearch.com',
        sourcePath: '/p',
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'browser_console_message',
      expect.objectContaining({
        channel: 'channel',
        consoleType: 'error',
        message: 'SpadeClient send error -1 : Failed to fetch',
        sourceHost: 'assets.twitch.tv',
      }),
    );
  });

  it('closePage 與 stop 會移除全部 diagnostics listener', async () => {
    const closedPage = new MockPageAdapter('closed');
    const stoppedPage = new MockPageAdapter('stopped');
    const context = new MockContextAdapter([closedPage, stoppedPage]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    await manager.start();
    await manager.createPage('closed');
    await manager.createPage('stopped');

    await manager.closePage('closed');
    closedPage.emitRequestFailed({
      url: 'https://static.twitchcdn.net/after-close.js',
      method: 'GET',
      resourceType: 'script',
    });
    closedPage.emitConsole({ type: 'error', text: 'after close' });
    closedPage.emitResponse({
      url: 'https://static.twitchcdn.net/after-close.js',
      method: 'GET',
      resourceType: 'script',
      status: 500,
      statusText: 'Error',
    });

    await manager.stop();
    stoppedPage.emitRequestFailed({
      url: 'https://static.twitchcdn.net/after-stop.js',
      method: 'GET',
      resourceType: 'script',
    });
    stoppedPage.emitConsole({ type: 'error', text: 'after stop' });
    stoppedPage.emitResponse({
      url: 'https://static.twitchcdn.net/after-stop.js',
      method: 'GET',
      resourceType: 'script',
      status: 500,
      statusText: 'Error',
    });

    const diagnosticEvents = new Set([
      'browser_request_failed',
      'browser_http_response',
      'browser_console_message',
    ]);
    for (const [event] of vi.mocked(logger.warn).mock.calls) {
      expect(diagnosticEvents.has(String(event))).toBe(false);
    }
    for (const [event] of vi.mocked(logger.debug).mock.calls) {
      expect(diagnosticEvents.has(String(event))).toBe(false);
    }
  });
});

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
