import type { Page } from 'playwright';

import {
  LOG_EVENTS,
  redactSensitiveString,
} from '../logging/Logger.js';
import { PlaywrightBrowserLauncher } from './adapters/PlaywrightBrowserLauncher.js';
import {
  decideConsoleLevel,
  decideHttpResponseLevel,
  sanitizeBrowserUrl,
} from './browser-diagnostics.js';
import type {
  BrowserAdapter,
  BrowserConsoleDiagnostic,
  BrowserContextAdapter,
  BrowserFatalRecoveryObserver,
  BrowserHttpResponseDiagnostic,
  BrowserInvalidation,
  BrowserInvalidationObserver,
  BrowserInvalidationReason,
  BrowserLauncher,
  BrowserManager,
  BrowserManagerConfig,
  BrowserManagerDependencies,
  BrowserManagerLogger,
  BrowserNavigationOutcome,
  BrowserPageAdapter,
  BrowserRequestFailureDiagnostic,
  BrowserRestartedEvent,
  BrowserRestartedObserver,
  BrowserTeardownResult,
  CloseOutcome,
  DetachedResources,
  PageEntry,
  RestartSchedule,
} from './types.js';

export { PlaywrightBrowserLauncher } from './adapters/PlaywrightBrowserLauncher.js';
export type {
  BrowserAdapter,
  BrowserConsoleDiagnostic,
  BrowserContextAdapter,
  BrowserContextOptions,
  BrowserFatalRecoveryObserver,
  BrowserHttpResponseDiagnostic,
  BrowserInvalidation,
  BrowserInvalidationObserver,
  BrowserInvalidationReason,
  BrowserLauncher,
  BrowserLaunchOptions,
  BrowserManager,
  BrowserManagerConfig,
  BrowserManagerDependencies,
  BrowserManagerLogger,
  BrowserNavigationOutcome,
  BrowserPageAdapter,
  BrowserRequestFailureDiagnostic,
  BrowserRestartedEvent,
  BrowserRestartedObserver,
  BrowserTeardownResult,
  CloseOutcome,
  ResourceBlockingOptions,
} from './types.js';

const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const DEFAULT_RESTART_BACKOFF_MAX_MS = 30_000;
const DEFAULT_MAX_AUTOMATIC_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_ATTEMPT_RESET_MS = 60_000;
const DEFAULT_RESOURCE_CLOSE_TIMEOUT_MS = 10_000;

export class BrowserTerminationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BrowserTerminationError';
  }
}

const NOOP_LOGGER: BrowserManagerLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

export class DefaultBrowserManager implements BrowserManager {
  private readonly launcher: BrowserLauncher;
  private readonly logger: BrowserManagerLogger;
  private readonly onInvalidated: BrowserInvalidationObserver | undefined;
  private readonly onFatalRecovery: BrowserFatalRecoveryObserver | undefined;
  private readonly onBrowserRestarted: BrowserRestartedObserver | undefined;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly restartBackoffMs: number;
  private readonly restartBackoffMaxMs: number;
  private readonly maxAutomaticRestartAttempts: number;
  private readonly restartAttemptResetMs: number;
  private readonly resourceCloseTimeoutMs: number;
  private readonly multiChannelCrashThreshold: number;
  private readonly multiChannelCrashWindowMs: number;
  private readonly browserFailureContainerThreshold: number;
  private readonly browserFailureWindowMs: number;

  private browser: BrowserAdapter | undefined;
  private context: BrowserContextAdapter | undefined;
  private unsubscribeBrowser: (() => void) | undefined;
  private readonly pages = new Map<string, PageEntry>();
  private browserGeneration = 0;
  private nextPageGeneration = 0;
  private trackedChannels = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();
  private navigationOutcomeTail: Promise<void> = Promise.resolve();
  private restartFlight: Promise<void> | undefined;
  private automaticRestartFlight: Promise<void> | undefined;
  private automaticRestartToken: symbol | undefined;
  private automaticRestartRecoveryEpoch: number | undefined;
  private desiredRunning = false;
  private recoveryEpoch = 0;
  private automaticRestartAttempts = 0;
  private lastBrowserCrashAt: number | undefined;
  private pendingForcedRecycleReason: string | undefined;
  private correlatedPageCrashes = new Map<string, number>();
  private pageCrashRecycleGeneration: number | undefined;
  private browserFailureTimestamps: number[] = [];

  public constructor(
    private readonly config: BrowserManagerConfig,
    dependencies: BrowserManagerDependencies = {},
  ) {
    this.launcher = dependencies.launcher ?? new PlaywrightBrowserLauncher();
    this.logger = dependencies.logger ?? NOOP_LOGGER;
    this.onInvalidated = dependencies.onInvalidated;
    this.onFatalRecovery = dependencies.onFatalRecovery;
    this.onBrowserRestarted = dependencies.onBrowserRestarted;
    this.sleep =
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    this.now = dependencies.now ?? Date.now;
    this.restartBackoffMs = positiveInteger(
      dependencies.restartBackoffMs,
      DEFAULT_RESTART_BACKOFF_MS,
    );
    this.restartBackoffMaxMs = positiveInteger(
      dependencies.restartBackoffMaxMs,
      DEFAULT_RESTART_BACKOFF_MAX_MS,
    );
    this.maxAutomaticRestartAttempts = positiveInteger(
      dependencies.maxAutomaticRestartAttempts,
      DEFAULT_MAX_AUTOMATIC_RESTART_ATTEMPTS,
    );
    this.restartAttemptResetMs = positiveInteger(
      dependencies.restartAttemptResetMs,
      DEFAULT_RESTART_ATTEMPT_RESET_MS,
    );
    this.resourceCloseTimeoutMs = positiveInteger(
      dependencies.resourceCloseTimeoutMs,
      DEFAULT_RESOURCE_CLOSE_TIMEOUT_MS,
    );
    this.multiChannelCrashThreshold =
      config.browser.recovery.multiChannelCrashThreshold;
    this.multiChannelCrashWindowMs =
      config.browser.recovery.multiChannelCrashWindowSeconds * 1_000;
    this.browserFailureContainerThreshold =
      config.browser.recovery.browserFailureContainerThreshold;
    this.browserFailureWindowMs =
      config.browser.recovery.browserFailureWindowSeconds * 1_000;
  }

  public async start(): Promise<void> {
    await this.runExclusive(async () => {
      if (this.browser !== undefined && this.context !== undefined) {
        this.desiredRunning = true;
        return;
      }

      this.desiredRunning = true;
      this.recoveryEpoch += 1;
      this.automaticRestartAttempts = 0;
      this.lastBrowserCrashAt = undefined;

      try {
        await this.startUnlocked();
      } catch (error: unknown) {
        this.desiredRunning = false;
        this.logger.error('browser_start_failed', {
          error: this.safeError(error),
        });
        throw error;
      }
    });
  }

  public async stop(): Promise<void> {
    await this.runExclusive(async () => {
      this.desiredRunning = false;
      this.recoveryEpoch += 1;
      this.automaticRestartAttempts = 0;
      this.lastBrowserCrashAt = undefined;

      const resources = this.detachResourcesUnlocked();
      await this.closeResourcesUnlocked(resources, 'stop');
    });
  }

  public async createPage(channel: string): Promise<Page> {
    // Wait for any in-flight full recycle scheduled after a failed page close.
    const pendingRestart = this.restartFlight;
    if (pendingRestart !== undefined) {
      await pendingRestart;
    }

    return this.runExclusive(async () => {
      if (this.pendingForcedRecycleReason !== undefined) {
        throw new Error(
          `Browser recycle required (${this.pendingForcedRecycleReason}); cannot create page`,
        );
      }

      const existing = this.pages.get(channel);
      if (existing !== undefined) {
        return existing.adapter.page;
      }

      const context = this.context;
      if (context === undefined || this.browser === undefined) {
        throw new Error('Browser Manager 尚未啟動');
      }

      let adapter: BrowserPageAdapter | undefined;

      try {
        adapter = await context.newPage();
        const entry = this.attachPageUnlocked(
          channel,
          adapter,
          this.browserGeneration,
        );
        this.pages.set(channel, entry);
        this.trackedChannels.add(channel);
        return adapter.page;
      } catch (error: unknown) {
        if (adapter !== undefined) {
          await this.closePageAdapterForCleanup(adapter, channel, 'create');
        }
        this.logger.error('browser_page_create_failed', {
          channel,
          error: this.safeError(error),
        });
        throw error;
      }
    });
  }

  public async closePage(channel: string): Promise<void> {
    let scheduleRecycleReason: string | undefined;

    await this.runExclusive(async () => {
      const entry = this.pages.get(channel);
      if (entry === undefined) {
        return;
      }

      this.detachPageListeners(entry);
      const outcome = await this.closePageAdapterWithTimeout(
        entry.adapter,
        channel,
        'close',
      );

      if (
        outcome.status === 'closed' ||
        outcome.status === 'already_closed' ||
        entry.adapter.isClosed()
      ) {
        if (this.pages.get(channel) === entry) {
          this.pages.delete(channel);
        }
        if (entry.browserGeneration === this.browserGeneration) {
          this.trackedChannels.delete(channel);
        }
        return;
      }

      // Timeout or failed close while page may still be alive: do not allow
      // another page in the same shared context. Schedule a full browser recycle
      // asynchronously after releasing the exclusive lock (avoids SessionManager
      // / BrowserManager lock cycles).
      if (this.pages.get(channel) === entry) {
        this.pages.delete(channel);
      }
      if (entry.browserGeneration === this.browserGeneration) {
        this.trackedChannels.delete(channel);
      }
      scheduleRecycleReason =
        outcome.status === 'timed_out'
          ? 'page_close_timeout'
          : 'page_close_failed';
      this.pendingForcedRecycleReason = scheduleRecycleReason;
      this.logger.warn('browser_page_close_requires_recycle', {
        channel,
        reason: scheduleRecycleReason,
        phase: 'close',
      });
    });

    if (scheduleRecycleReason !== undefined) {
      void this.restart().catch((error: unknown) => {
        this.logger.error('browser_page_close_recycle_failed', {
          reason: scheduleRecycleReason,
          error: this.safeError(error),
        });
        this.requestFatalRecovery('browser_page_close_recycle_failed', {
          reason: scheduleRecycleReason,
        });
      });
    }
  }

  public restart(): Promise<void> {
    const existingFlight = this.restartFlight;
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const flight = this.restartManually();
    this.restartFlight = flight;
    flight.then(
      () => {
        if (this.restartFlight === flight) {
          this.restartFlight = undefined;
        }
      },
      () => {
        if (this.restartFlight === flight) {
          this.restartFlight = undefined;
        }
      },
    );
    return flight;
  }

  public getPageCount(): number {
    return this.pages.size;
  }

  public getBrowserGeneration(): number {
    return this.browserGeneration;
  }

  public getBrowserVersion(): string | null {
    return this.browser?.getVersion() ?? null;
  }

  public reportNavigationOutcomes(
    outcomes: readonly BrowserNavigationOutcome[],
  ): Promise<void> {
    if (outcomes.length === 0) {
      return Promise.resolve();
    }

    const reportedRecoveryEpoch = this.recoveryEpoch;
    const outcomeSnapshot = [...outcomes];
    const result = this.navigationOutcomeTail.then(
      () =>
        this.processNavigationOutcomes(
          outcomeSnapshot,
          reportedRecoveryEpoch,
        ),
      () =>
        this.processNavigationOutcomes(
          outcomeSnapshot,
          reportedRecoveryEpoch,
        ),
    );
    this.navigationOutcomeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async restartManually(): Promise<void> {
    const invalidatedChannels: string[] = [];
    let terminationConfirmed = false;
    let relaunchError: unknown;

    try {
      await this.runExclusive(async () => {
        this.desiredRunning = true;
        this.recoveryEpoch += 1;
        this.automaticRestartAttempts = 0;
        this.lastBrowserCrashAt = undefined;
        this.pendingForcedRecycleReason = undefined;
        invalidatedChannels.push(...this.pages.keys());

        const resources = this.detachResourcesUnlocked();
        const teardown = await this.closeResourcesUnlocked(
          resources,
          'restart',
        );
        terminationConfirmed = teardown.browserTerminated;

        if (!terminationConfirmed) {
          this.logger.error('browser_termination_unconfirmed', {
            mode: 'manual',
            pageCloseTimedOut: teardown.pageCloseTimedOut,
            browserCloseTimedOut: teardown.browserCloseTimedOut,
            browserCloseFailed: teardown.browserCloseFailed,
          });
          return;
        }

        try {
          await this.startUnlocked();
          this.logger.warn(LOG_EVENTS.BROWSER_RESTARTED, {
            mode: 'manual',
            affectedChannelCount: invalidatedChannels.length,
            browserGeneration: this.browserGeneration,
          });
          this.emitBrowserRestarted({ mode: 'manual' });
        } catch (error: unknown) {
          relaunchError = error;
          this.logger.error('browser_restart_failed', {
            mode: 'manual',
            error: this.safeError(error),
          });
        }
      });
    } finally {
      await this.notifyInvalidations(
        invalidatedChannels,
        'browser_restarted',
      );
    }

    if (!terminationConfirmed) {
      this.requestFatalRecovery('browser_termination_unconfirmed', {
        mode: 'manual',
      });
      throw new BrowserTerminationError(
        'Old browser termination was not confirmed; replacement launch skipped',
      );
    }

    if (relaunchError !== undefined) {
      throw relaunchError instanceof Error
        ? relaunchError
        : new Error('Browser relaunch failed');
    }
  }

  private async startUnlocked(): Promise<void> {
    if (this.browser !== undefined && this.context !== undefined) {
      return;
    }

    let browser: BrowserAdapter | undefined;
    let context: BrowserContextAdapter | undefined;
    let unsubscribeBrowser: (() => void) | undefined;

    try {
      const nextBrowserGeneration = this.browserGeneration + 1;
      browser = await this.launcher.launch({
        headless: this.config.headless,
      });
      const launchedBrowser = browser;
      unsubscribeBrowser = browser.onDisconnected(() => {
        void this.handleBrowserDisconnected(
          launchedBrowser,
          nextBrowserGeneration,
        );
      });
      context = await browser.newContext({
        storageState: this.config.storageStatePath,
        viewport: {
          width: this.config.browser.viewportWidth,
          height: this.config.browser.viewportHeight,
        },
      });
      await context.configureResourceBlocking({
        blockImages: this.config.browser.blockImages,
        blockFonts: this.config.browser.blockFonts,
        blockKnownTracking: this.config.browser.blockKnownTracking,
      });
      await context.configureChatBlocking(this.config.browser.disableChat);

      this.browser = browser;
      this.context = context;
      this.unsubscribeBrowser = unsubscribeBrowser;
      this.browserGeneration = nextBrowserGeneration;
      this.trackedChannels = new Set<string>();
      this.correlatedPageCrashes = new Map<string, number>();
      this.pageCrashRecycleGeneration = undefined;
    } catch (error: unknown) {
      unsubscribeBrowser?.();
      await this.closeResourcesUnlocked(
        {
          browser,
          context,
          pages: [],
          unsubscribeBrowser: undefined,
        },
        'start_failure',
      );
      throw error;
    }
  }

  private attachPageUnlocked(
    channel: string,
    adapter: BrowserPageAdapter,
    browserGeneration: number,
  ): PageEntry {
    const pageGeneration = ++this.nextPageGeneration;
    const entry: PageEntry = {
      adapter,
      browserGeneration,
      pageGeneration,
      unsubscribeCrash: () => undefined,
      unsubscribeClose: () => undefined,
      unsubscribePopup: () => undefined,
      unsubscribeRequestFailed: () => undefined,
      unsubscribeResponse: () => undefined,
      unsubscribeConsole: () => undefined,
    };

    try {
      entry.unsubscribeCrash = adapter.onCrash(() => {
        void this.handlePageInvalidation(channel, entry, 'page_crashed');
      });
      entry.unsubscribeClose = adapter.onClose(() => {
        void this.handlePageInvalidation(channel, entry, 'page_closed');
      });
      entry.unsubscribePopup = adapter.onPopup((popup) => {
        void this.closeUnexpectedPopup(channel, popup);
      });
      entry.unsubscribeRequestFailed = adapter.onRequestFailed((diagnostic) => {
        this.logRequestFailure(channel, entry, diagnostic);
      });
      entry.unsubscribeResponse = adapter.onResponse((diagnostic) => {
        this.logHttpResponse(channel, entry, diagnostic);
      });
      entry.unsubscribeConsole = adapter.onConsole((diagnostic) => {
        this.logConsoleMessage(channel, entry, diagnostic);
      });
    } catch (error: unknown) {
      this.detachPageListeners(entry);
      throw error;
    }
    return entry;
  }

  private reattachPageListeners(channel: string, entry: PageEntry): void {
    entry.unsubscribeCrash = entry.adapter.onCrash(() => {
      void this.handlePageInvalidation(channel, entry, 'page_crashed');
    });
    entry.unsubscribeClose = entry.adapter.onClose(() => {
      void this.handlePageInvalidation(channel, entry, 'page_closed');
    });
    entry.unsubscribePopup = entry.adapter.onPopup((popup) => {
      void this.closeUnexpectedPopup(channel, popup);
    });
    entry.unsubscribeRequestFailed = entry.adapter.onRequestFailed((diagnostic) => {
      this.logRequestFailure(channel, entry, diagnostic);
    });
    entry.unsubscribeResponse = entry.adapter.onResponse((diagnostic) => {
      this.logHttpResponse(channel, entry, diagnostic);
    });
    entry.unsubscribeConsole = entry.adapter.onConsole((diagnostic) => {
      this.logConsoleMessage(channel, entry, diagnostic);
    });
  }

  private async closeUnexpectedPopup(
    channel: string,
    popup: Page,
  ): Promise<void> {
    try {
      if (!popup.isClosed()) {
        await popup.close();
      }
      this.logger.warn('browser_popup_blocked', { channel });
    } catch (error: unknown) {
      this.logger.warn('browser_popup_close_failed', {
        channel,
        error: this.safeError(error),
      });
    }
  }

  private async handlePageInvalidation(
    channel: string,
    invalidatedEntry: PageEntry,
    reason: Extract<
      BrowserInvalidationReason,
      'page_crashed' | 'page_closed'
    >,
  ): Promise<void> {
    const startedAtMs = Date.now();
    this.logger.debug('browser_page_invalidation_started', {
      channel,
      reason,
      pageCountBefore: this.pages.size,
      browserGeneration: invalidatedEntry.browserGeneration,
      pageGeneration: invalidatedEntry.pageGeneration,
    });
    let shouldNotify: boolean;

    try {
      shouldNotify = await this.runExclusive(async () => {
        const entry = this.pages.get(channel);
        if (entry === undefined || entry !== invalidatedEntry) {
          this.logger.debug('browser_page_invalidation_completed', {
            channel,
            reason,
            pageKnown: false,
            notified: false,
            pageCountAfter: this.pages.size,
            durationMs: Date.now() - startedAtMs,
            browserGeneration: invalidatedEntry.browserGeneration,
            pageGeneration: invalidatedEntry.pageGeneration,
          });
          return false;
        }

        this.pages.delete(channel);
        this.detachPageListeners(entry);

        if (reason === 'page_crashed') {
          await this.closePageAdapterForCleanup(
            invalidatedEntry.adapter,
            channel,
            'crash',
          );
        }

        this.logger.warn(reason, {
          channel,
          browserGeneration: invalidatedEntry.browserGeneration,
          pageGeneration: invalidatedEntry.pageGeneration,
        });
        this.logger.debug('browser_page_invalidation_completed', {
          channel,
          reason,
          pageKnown: true,
          notified: true,
          pageCountAfter: this.pages.size,
          durationMs: Date.now() - startedAtMs,
          browserGeneration: invalidatedEntry.browserGeneration,
          pageGeneration: invalidatedEntry.pageGeneration,
        });
        return true;
      });
    } catch (error: unknown) {
      this.logger.error('browser_page_invalidation_failed', {
        channel,
        reason,
        error: this.safeError(error),
      });
      return;
    }

    if (shouldNotify) {
      await this.notifyInvalidation({ channel, reason });
      this.logger.debug('browser_page_invalidation_notified', {
        channel,
        reason,
        durationMs: Date.now() - startedAtMs,
        browserGeneration: invalidatedEntry.browserGeneration,
        pageGeneration: invalidatedEntry.pageGeneration,
      });
      if (reason === 'page_crashed') {
        this.recordPageCrash(
          channel,
          invalidatedEntry.browserGeneration,
          invalidatedEntry.pageGeneration,
        );
      }
    }
  }

  private async handleBrowserDisconnected(
    disconnectedBrowser: BrowserAdapter,
    disconnectedBrowserGeneration: number,
  ): Promise<void> {
    let invalidatedChannels: string[] = [];
    let restartSchedule: RestartSchedule | undefined;
    let escalateToContainer = false;

    try {
      await this.runExclusive(async () => {
        if (this.browser !== disconnectedBrowser) {
          return;
        }

        invalidatedChannels = [...this.trackedChannels];
        this.recoveryEpoch += 1;
        const recoveryEpoch = this.recoveryEpoch;
        const resources = this.detachResourcesUnlocked();

        this.logger.warn('browser_disconnected', {
          affectedChannels: invalidatedChannels,
          affectedChannelCount: invalidatedChannels.length,
          browserGeneration: disconnectedBrowserGeneration,
        });
        await this.closeResourcesUnlocked(resources, 'disconnect');

        if (this.desiredRunning && this.config.browser.restartOnCrash) {
          escalateToContainer = this.recordBrowserFailure();
          if (!escalateToContainer) {
            restartSchedule = this.nextRestartSchedule(recoveryEpoch, true);
          }
        }
      });
    } catch (error: unknown) {
      this.logger.error('browser_disconnect_cleanup_failed', {
        error: this.safeError(error),
      });
    }

    await this.notifyInvalidations(
      invalidatedChannels,
      'browser_disconnected',
    );

    if (escalateToContainer) {
      this.requestFatalRecovery('browser_crash_loop', {
        browserFailureWindowMs: this.browserFailureWindowMs,
        browserFailureContainerThreshold:
          this.browserFailureContainerThreshold,
      });
      return;
    }

    if (restartSchedule !== undefined) {
      this.scheduleAutomaticRestart(restartSchedule);
    }
  }

  private nextRestartSchedule(
    recoveryEpoch: number,
    resetAttemptsAfterStablePeriod: boolean,
  ): RestartSchedule | undefined {
    if (resetAttemptsAfterStablePeriod) {
      const crashAt = this.now();
      if (
        this.lastBrowserCrashAt === undefined ||
        crashAt - this.lastBrowserCrashAt >= this.restartAttemptResetMs
      ) {
        this.automaticRestartAttempts = 0;
      }
      this.lastBrowserCrashAt = crashAt;
    }

    if (
      this.automaticRestartAttempts >=
      this.maxAutomaticRestartAttempts
    ) {
      this.logger.error('browser_restart_limit_reached', {
        maxAttempts: this.maxAutomaticRestartAttempts,
      });
      this.requestFatalRecovery('automatic_restart_limit_reached', {
        maxAttempts: this.maxAutomaticRestartAttempts,
      });
      return undefined;
    }

    this.automaticRestartAttempts += 1;
    const attempt = this.automaticRestartAttempts;
    const delayMs = Math.min(
      this.restartBackoffMs * 2 ** (attempt - 1),
      this.restartBackoffMaxMs,
    );

    this.logger.warn('browser_restart_scheduled', { attempt, delayMs });
    return { attempt, delayMs, recoveryEpoch };
  }

  private scheduleAutomaticRestart(schedule: RestartSchedule): void {
    if (
      this.automaticRestartFlight !== undefined &&
      this.automaticRestartRecoveryEpoch === schedule.recoveryEpoch
    ) {
      return;
    }

    const token = Symbol('automatic-browser-restart');
    this.automaticRestartToken = token;
    this.automaticRestartRecoveryEpoch = schedule.recoveryEpoch;
    const flight = Promise.resolve().then(async () => {
      try {
        await this.sleep(schedule.delayMs);
      } catch (error: unknown) {
        this.logger.error('browser_restart_backoff_failed', {
          attempt: schedule.attempt,
          error: this.safeError(error),
        });
        return;
      } finally {
        if (this.automaticRestartToken === token) {
          this.automaticRestartToken = undefined;
          this.automaticRestartRecoveryEpoch = undefined;
          this.automaticRestartFlight = undefined;
        }
      }

      await this.recoverAutomatically(schedule);
    });

    this.automaticRestartFlight = flight;
    flight.catch((error: unknown) => {
      this.logger.error('browser_restart_task_failed', {
        attempt: schedule.attempt,
        error: this.safeError(error),
      });
    });
  }

  private async recoverAutomatically(schedule: RestartSchedule): Promise<void> {
    await this.runExclusive(async () => {
      if (
        !this.desiredRunning ||
        schedule.recoveryEpoch !== this.recoveryEpoch ||
        (this.browser !== undefined && this.context !== undefined)
      ) {
        return;
      }

      try {
        await this.startUnlocked();
      } catch (error: unknown) {
        this.logger.error('browser_restart_failed', {
          mode: 'automatic',
          attempt: schedule.attempt,
          error: this.safeError(error),
        });
        const retrySchedule = this.nextRestartSchedule(
          schedule.recoveryEpoch,
          false,
        );
        if (retrySchedule !== undefined) {
          this.scheduleAutomaticRestart(retrySchedule);
        }
        // When retrySchedule is undefined, nextRestartSchedule already
        // requested a container restart for attempt exhaustion.
        return;
      }

      this.logger.warn(LOG_EVENTS.BROWSER_RESTARTED, {
        mode: 'automatic',
        attempt: schedule.attempt,
        browserGeneration: this.browserGeneration,
      });
      this.emitBrowserRestarted({ mode: 'automatic' });
    });
  }

  private emitBrowserRestarted(event: BrowserRestartedEvent): void {
    try {
      this.onBrowserRestarted?.(event);
    } catch (error: unknown) {
      this.logger.debug('browser_restarted_observer_failed', {
        error: this.safeError(error),
      });
    }
  }

  private detachResourcesUnlocked(): DetachedResources {
    const resources: DetachedResources = {
      browser: this.browser,
      context: this.context,
      pages: [...this.pages.values()],
      unsubscribeBrowser: this.unsubscribeBrowser,
    };

    this.browser = undefined;
    this.context = undefined;
    this.unsubscribeBrowser = undefined;
    this.pages.clear();
    this.trackedChannels = new Set<string>();
    resources.unsubscribeBrowser?.();
    for (const entry of resources.pages) {
      this.detachPageListeners(entry);
    }

    return resources;
  }

  private async closeResourcesUnlocked(
    resources: DetachedResources,
    phase: string,
  ): Promise<BrowserTeardownResult> {
    let pageCloseTimedOut = false;

    for (const entry of resources.pages) {
      const pageOutcome = await this.closePageAdapterForCleanup(
        entry.adapter,
        undefined,
        phase,
      );
      if (pageOutcome.status === 'timed_out') {
        pageCloseTimedOut = true;
      }
    }

    await this.closeResourceForCleanup(
      resources.context,
      'browser_context_close_failed',
      phase,
    );

    let browserCloseTimedOut = false;
    let browserCloseFailed = false;
    const browser = resources.browser;
    if (browser !== undefined) {
      // Already disconnected: cleanup errors on wrappers are non-fatal.
      if (!browser.isConnected()) {
        await this.closeResourceForCleanup(
          browser,
          'browser_close_failed',
          phase,
        );
        return {
          browserTerminated: true,
          pageCloseTimedOut,
          browserCloseTimedOut: false,
          browserCloseFailed: false,
        };
      }

      const browserOutcome = await this.closeResourceForCleanup(
        browser,
        'browser_close_failed',
        phase,
      );
      browserCloseTimedOut = browserOutcome.status === 'timed_out';
      browserCloseFailed = browserOutcome.status === 'failed';
    }

    const browserTerminated =
      browser === undefined || !browser.isConnected();

    return {
      browserTerminated,
      pageCloseTimedOut,
      browserCloseTimedOut,
      browserCloseFailed,
    };
  }

  private async closePageAdapterForCleanup(
    adapter: BrowserPageAdapter,
    channel: string | undefined,
    phase: string,
  ): Promise<CloseOutcome> {
    if (adapter.isClosed()) {
      return { status: 'already_closed' };
    }

    const outcome = await this.closePageAdapterWithTimeout(
      adapter,
      channel,
      phase,
    );
    if (outcome.status === 'failed') {
      this.logger.warn('browser_page_cleanup_failed', {
        ...(channel === undefined ? {} : { channel }),
        phase,
        error: this.safeError(outcome.error),
      });
    }
    return outcome;
  }

  private async closeResourceForCleanup(
    resource: { close(): Promise<void> } | undefined,
    event: string,
    phase: string,
  ): Promise<CloseOutcome> {
    if (resource === undefined) {
      return { status: 'already_closed' };
    }

    const outcome = await this.closeWithTimeout(
      resource.close(),
      event.replace('_failed', '_timeout'),
      { phase },
    );
    if (outcome.status === 'failed') {
      this.logger.warn(event, {
        phase,
        error: this.safeError(outcome.error),
      });
    }
    return outcome;
  }

  private async closePageAdapterWithTimeout(
    adapter: BrowserPageAdapter,
    channel: string | undefined,
    phase: string,
  ): Promise<CloseOutcome> {
    if (adapter.isClosed()) {
      return { status: 'already_closed' };
    }
    return this.closeWithTimeout(
      adapter.close(),
      'browser_page_close_timeout',
      {
        ...(channel === undefined ? {} : { channel }),
        phase,
      },
    );
  }

  private async closeWithTimeout(
    closePromise: Promise<void>,
    timeoutEvent: string,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<CloseOutcome> {
    const startedAtMs = Date.now();
    this.logger.debug('browser_resource_close_started', {
      ...fields,
      timeoutEvent,
      timeoutMs: this.resourceCloseTimeoutMs,
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    // Attach rejection handler so a late rejection after timeout is not unhandled.
    closePromise.catch(() => undefined);

    try {
      const raceResult = await Promise.race([
        closePromise.then(
          () => ({ kind: 'closed' as const }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        ),
        new Promise<{ kind: 'timed_out' }>((resolve) => {
          timeoutHandle = setTimeout(() => {
            resolve({ kind: 'timed_out' });
          }, this.resourceCloseTimeoutMs);
        }),
      ]);

      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }

      if (raceResult.kind === 'timed_out') {
        this.logger.warn(timeoutEvent, {
          ...fields,
          timeoutMs: this.resourceCloseTimeoutMs,
        });
        this.logger.debug('browser_resource_close_completed', {
          ...fields,
          timeoutEvent,
          timedOut: true,
          status: 'timed_out',
          durationMs: Date.now() - startedAtMs,
        });
        return { status: 'timed_out' };
      }

      if (raceResult.kind === 'failed') {
        this.logger.debug('browser_resource_close_completed', {
          ...fields,
          timeoutEvent,
          timedOut: false,
          status: 'failed',
          durationMs: Date.now() - startedAtMs,
        });
        return { status: 'failed', error: raceResult.error };
      }

      this.logger.debug('browser_resource_close_completed', {
        ...fields,
        timeoutEvent,
        timedOut: false,
        status: 'closed',
        durationMs: Date.now() - startedAtMs,
      });
      return { status: 'closed' };
    } catch (error: unknown) {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      return { status: 'failed', error };
    }
  }

  private recordPageCrash(
    channel: string,
    browserGeneration: number,
    pageGeneration: number,
  ): void {
    if (
      browserGeneration !== this.browserGeneration ||
      this.browser === undefined ||
      this.context === undefined ||
      this.restartFlight !== undefined ||
      this.pageCrashRecycleGeneration === browserGeneration
    ) {
      return;
    }

    const nowMs = this.now();
    for (const [crashedChannel, timestampMs] of this.correlatedPageCrashes) {
      if (nowMs - timestampMs > this.multiChannelCrashWindowMs) {
        this.correlatedPageCrashes.delete(crashedChannel);
      }
    }

    const normalizedChannel = normalizeChannel(channel);
    this.correlatedPageCrashes.set(normalizedChannel, nowMs);
    const affectedChannels = [...this.correlatedPageCrashes.keys()];
    if (affectedChannels.length < this.multiChannelCrashThreshold) {
      return;
    }

    this.pageCrashRecycleGeneration = browserGeneration;
    const reason = 'multi_channel_page_crash';
    this.logger.warn('browser_crash_loop_recycle_requested', {
      reason,
      channel,
      affectedChannels,
      distinctChannelCount: affectedChannels.length,
      browserGeneration,
      pageGeneration,
    });

    // Count crash-driven full recycle toward browser failure breaker.
    if (this.recordBrowserFailure()) {
      this.requestFatalRecovery('browser_crash_loop', {
        reason,
        channel,
      });
      return;
    }

    void this.restart().catch((error: unknown) => {
      this.logger.error('browser_crash_loop_recycle_failed', {
        reason,
        error: this.safeError(error),
      });
      this.requestFatalRecovery('browser_crash_loop_recycle_failed', {
        reason,
        channel,
      });
    });
  }

  private async processNavigationOutcomes(
    outcomes: readonly BrowserNavigationOutcome[],
    reportedRecoveryEpoch: number,
  ): Promise<void> {
    await this.runExclusive(async () => {
      if (
        !this.desiredRunning ||
        this.browser === undefined ||
        this.context === undefined ||
        reportedRecoveryEpoch !== this.recoveryEpoch
      ) {
        return;
      }

      for (const outcome of outcomes) {
        if (outcome.status !== 'timed_out') {
          continue;
        }
        this.logger.debug('browser_navigation_failure_recorded', {
          channel: outcome.channel,
          status: outcome.status,
          recovery: 'per_channel',
          browserGeneration: this.browserGeneration,
        });
      }
    });
  }

  /**
   * Record an unexpected browser failure. Returns true when container restart
   * should be requested instead of another browser recycle.
   */
  private recordBrowserFailure(): boolean {
    const nowMs = this.now();
    this.browserFailureTimestamps = evictOldTimestamps(
      this.browserFailureTimestamps,
      nowMs,
      this.browserFailureWindowMs,
    );
    this.browserFailureTimestamps.push(nowMs);
    return (
      this.browserFailureTimestamps.length >=
      this.browserFailureContainerThreshold
    );
  }

  private requestFatalRecovery(
    reason: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    const observer = this.onFatalRecovery;
    if (observer === undefined) {
      return;
    }
    void Promise.resolve()
      .then(() =>
        observer({
          reason,
          ...(fields === undefined ? {} : { fields }),
        }),
      )
      .catch((error: unknown) => {
        this.logger.error('browser_fatal_recovery_observer_failed', {
          reason,
          error: this.safeError(error),
        });
      });
  }

  private detachPageListeners(entry: PageEntry): void {
    entry.unsubscribeCrash();
    entry.unsubscribeClose();
    entry.unsubscribePopup();
    entry.unsubscribeRequestFailed();
    entry.unsubscribeResponse();
    entry.unsubscribeConsole();
    entry.unsubscribeCrash = () => undefined;
    entry.unsubscribeClose = () => undefined;
    entry.unsubscribePopup = () => undefined;
    entry.unsubscribeRequestFailed = () => undefined;
    entry.unsubscribeResponse = () => undefined;
    entry.unsubscribeConsole = () => undefined;
  }

  private logRequestFailure(
    channel: string,
    entry: PageEntry,
    diagnostic: BrowserRequestFailureDiagnostic,
  ): void {
    try {
      const endpoint = sanitizeBrowserUrl(diagnostic.url);
      this.logger.warn('browser_request_failed', {
        channel,
        browserGeneration: entry.browserGeneration,
        pageGeneration: entry.pageGeneration,
        endpointCategory: endpoint.endpointCategory,
        host: endpoint.host,
        path: endpoint.path,
        method: diagnostic.method,
        resourceType: diagnostic.resourceType,
        ...(diagnostic.failureText === undefined
          ? {}
          : { failureText: diagnostic.failureText }),
        ...(diagnostic.graphQlOperationNames === undefined ||
        diagnostic.graphQlOperationNames.length === 0
          ? {}
          : { graphQlOperationNames: diagnostic.graphQlOperationNames }),
      });
    } catch (error: unknown) {
      this.logger.debug('browser_diagnostic_failed', {
        channel,
        event: 'browser_request_failed',
        error: this.safeError(error),
      });
    }
  }

  private logHttpResponse(
    channel: string,
    entry: PageEntry,
    diagnostic: BrowserHttpResponseDiagnostic,
  ): void {
    try {
      const endpoint = sanitizeBrowserUrl(diagnostic.url);
      const level = decideHttpResponseLevel(
        diagnostic.status,
        diagnostic.resourceType,
        endpoint.endpointCategory,
      );
      if (level === 'none') {
        return;
      }
      this.logger[level]('browser_http_response', {
        channel,
        browserGeneration: entry.browserGeneration,
        pageGeneration: entry.pageGeneration,
        endpointCategory: endpoint.endpointCategory,
        host: endpoint.host,
        path: endpoint.path,
        method: diagnostic.method,
        resourceType: diagnostic.resourceType,
        httpStatus: diagnostic.status,
        statusText: diagnostic.statusText,
        ...(diagnostic.graphQlOperationNames === undefined ||
        diagnostic.graphQlOperationNames.length === 0
          ? {}
          : { graphQlOperationNames: diagnostic.graphQlOperationNames }),
      });
    } catch (error: unknown) {
      this.logger.debug('browser_diagnostic_failed', {
        channel,
        event: 'browser_http_response',
        error: this.safeError(error),
      });
    }
  }

  private logConsoleMessage(
    channel: string,
    entry: PageEntry,
    diagnostic: BrowserConsoleDiagnostic,
  ): void {
    try {
      const level = decideConsoleLevel(diagnostic.type);
      if (level === 'none') {
        return;
      }
      const source =
        diagnostic.sourceUrl === undefined
          ? undefined
          : sanitizeBrowserUrl(diagnostic.sourceUrl);
      this.logger[level]('browser_console_message', {
        channel,
        browserGeneration: entry.browserGeneration,
        pageGeneration: entry.pageGeneration,
        consoleType: diagnostic.type,
        message: diagnostic.text,
        ...(source === undefined ? {} : { sourceHost: source.host }),
        ...(source === undefined || source.path.length === 0
          ? {}
          : { sourcePath: source.path }),
        ...(diagnostic.lineNumber === undefined
          ? {}
          : { lineNumber: diagnostic.lineNumber }),
        ...(diagnostic.columnNumber === undefined
          ? {}
          : { columnNumber: diagnostic.columnNumber }),
      });
    } catch (error: unknown) {
      this.logger.debug('browser_diagnostic_failed', {
        channel,
        event: 'browser_console_message',
        error: this.safeError(error),
      });
    }
  }

  private async notifyInvalidations(
    channels: readonly string[],
    reason: BrowserInvalidationReason,
  ): Promise<void> {
    await Promise.all(
      channels.map((channel) =>
        this.notifyInvalidation({ channel, reason }),
      ),
    );
  }

  private async notifyInvalidation(
    invalidation: BrowserInvalidation,
  ): Promise<void> {
    if (this.onInvalidated === undefined) {
      return;
    }

    try {
      await this.onInvalidated(invalidation);
    } catch (error: unknown) {
      this.logger.error('browser_invalidation_observer_failed', {
        channel: invalidation.channel,
        reason: invalidation.reason,
        error: this.safeError(error),
      });
    }
  }

  private safeError(error: unknown): Readonly<{
    name: string;
    message: string;
  }> {
    const storageStatePath = this.config.storageStatePath;
    const input =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'Error', message: String(error) };

    const redactedMessage = redactSensitiveString(input.message);
    return {
      name: redactSensitiveString(input.name),
      message:
        storageStatePath.length === 0
          ? redactedMessage
          : redactedMessage.replaceAll(storageStatePath, '[REDACTED]'),
    };
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release = (): void => undefined;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function evictOldTimestamps(
  timestamps: readonly number[],
  nowMs: number,
  windowMs: number,
): number[] {
  const cutoff = nowMs - windowMs;
  return timestamps.filter((timestamp) => timestamp >= cutoff);
}

function normalizeChannel(channel: string): string {
  return channel.trim().toLocaleLowerCase('en-US');
}
