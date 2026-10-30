import type { Page } from 'playwright';

import type { AppConfig } from '../config/AppConfig.js';
import {
  LOG_EVENTS,
  type Logger,
} from '../logging/index.js';
import type { BrowserManager } from './BrowserManager.js';
import {
  readChannelPointsBalance,
  type ChannelPointsReadResult,
} from './ChannelPointsReader.js';
import {
  acceptContentWarning,
  evaluateChannelHealth,
  type ChannelHealthEvaluator,
  type ChannelHealthResult,
} from './ChannelHealthChecker.js';
import type {
  RewardClaimer,
  RewardClaimResult,
} from './RewardClaimer.js';
import { collapseSideNav } from './SideNavCollapser.js';
import {
  DefaultStreamPlaybackOptimizer,
  type StreamPlaybackOptimizer,
} from './StreamPlaybackOptimizer.js';
import {
  CHANNEL_PATTERN,
  createChannelUrl,
  isExpectedChannelUrl,
  stableJitter,
} from './channel-url.js';
import { safeErrorMessage, safeLog } from './safe-logging.js';

export {
  CHANNEL_HEALTH_SELECTORS,
  acceptContentWarning,
  evaluateChannelHealth,
  type ChannelHealthEvaluator,
  type ChannelHealthFailureReason,
  type ChannelHealthResult,
  type ContentWarningAcceptResult,
} from './ChannelHealthChecker.js';
export {
  createChannelUrl,
  isExpectedChannelUrl,
  stableJitter,
} from './channel-url.js';
export { safeErrorMessage, safeLog } from './safe-logging.js';

const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3;
const MAX_TIMER_JITTER_MS = 5_000;
const MAX_PAGE_REFRESH_JITTER_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_PAGE_OPERATION_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_POINTS_CLAIM_RETRY_ATTEMPTS = 3;
const DEFAULT_POINTS_CLAIM_RETRY_DELAY_MS = 1_000;
export const REWARD_FAILURE_RECOVERY_THRESHOLD = 10;

export type ChannelSessionState =
  | 'starting'
  | 'watching'
  | 'recovering'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface ChannelSession {
  readonly channel: string;
  readonly state: ChannelSessionState;
  start(): Promise<void>;
  cancelStart?(reason: string): Promise<void>;
  stop(reason: string): Promise<void>;
  checkHealth(): Promise<ChannelHealthResult>;
  tickRewardClaim(): Promise<RewardClaimResult>;
  captureScreenshot(): Promise<Buffer>;
  getChannelPoints(): Promise<ChannelSessionPointsResult>;
  getRefreshStatus(): ChannelSessionRefreshStatus;
  refreshNow(): Promise<boolean>;
}

export type ChannelSessionPointsResult =
  | ChannelPointsReadResult
  | { readonly status: 'unavailable'; readonly reason: 'page_unavailable' };

export interface ChannelSessionFactory {
  create(channel: string): ChannelSession;
}

export type ChannelSessionLogger = Pick<
  Logger,
  'debug' | 'info' | 'warn' | 'error'
>;

export type ChannelSessionInvalidationObserver = (
  channel: string,
  reason: 'health_failure_threshold',
) => Promise<void> | void;

export interface ContainerRestartRequest {
  readonly channel: string;
  readonly reason: 'reward_claim_failure_after_refresh';
  readonly consecutiveFailures: number;
  readonly requestedAt: string;
}

export type ContainerRestartRequestObserver = (
  request: ContainerRestartRequest,
) => Promise<void> | void;

export interface ChannelSessionRefreshStatus {
  readonly channel: string;
  readonly enabled: boolean;
  readonly nextRefreshAt?: string;
  readonly secondsUntilRefresh?: number;
}

export interface ChannelSessionRefreshEvent {
  readonly channel: string;
  readonly reason: ChannelSessionRefreshReason;
  readonly startedAt: string;
}

export type ChannelSessionRefreshReason =
  | 'scheduled_refresh'
  | 'manual_refresh'
  | 'reward_claim_failure_threshold';

export type ChannelSessionRefreshObserver = (
  event: ChannelSessionRefreshEvent,
) => Promise<void> | void;

export interface DefaultChannelSessionOptions {
  readonly channel: string;
  readonly config: Pick<AppConfig, 'channels' | 'browser'>;
  readonly browserManager: BrowserManager;
  readonly rewardClaimer: RewardClaimer;
  readonly playbackOptimizer?: StreamPlaybackOptimizer;
  readonly logger?: ChannelSessionLogger;
  readonly healthFailureThreshold?: number;
  readonly healthEvaluator?: ChannelHealthEvaluator;
  readonly onInvalidated?: ChannelSessionInvalidationObserver;
  readonly onPageRefresh?: ChannelSessionRefreshObserver;
  readonly onContainerRestartRequested?: ContainerRestartRequestObserver;
  readonly pageOperationDrainTimeoutMs?: number;
  readonly pointsClaimRetryAttempts?: number;
  readonly pointsClaimRetryDelayMs?: number;
  readonly now?: () => Date;
}

export interface DefaultChannelSessionFactoryOptions {
  readonly config: Pick<AppConfig, 'channels' | 'browser'>;
  readonly browserManager: BrowserManager;
  readonly rewardClaimer: RewardClaimer;
  readonly playbackOptimizer?: StreamPlaybackOptimizer;
  readonly logger?: ChannelSessionLogger;
  readonly healthFailureThreshold?: number;
  readonly healthEvaluator?: ChannelHealthEvaluator;
  readonly onInvalidated?: ChannelSessionInvalidationObserver;
  readonly onPageRefresh?: ChannelSessionRefreshObserver;
  readonly onContainerRestartRequested?: ContainerRestartRequestObserver;
  readonly pageOperationDrainTimeoutMs?: number;
  readonly pointsClaimRetryAttempts?: number;
  readonly pointsClaimRetryDelayMs?: number;
  readonly now?: () => Date;
}

const NOOP_LOGGER: ChannelSessionLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

export class DefaultChannelSessionFactory implements ChannelSessionFactory {
  public constructor(
    private readonly options: DefaultChannelSessionFactoryOptions,
  ) {}

  public create(channel: string): ChannelSession {
    return new DefaultChannelSession({
      ...this.options,
      channel,
    });
  }
}

export class DefaultChannelSession implements ChannelSession {
  public readonly channel: string;

  private readonly targetUrl: string;
  private readonly browserManager: BrowserManager;
  private readonly rewardClaimer: RewardClaimer;
  private readonly playbackOptimizer: StreamPlaybackOptimizer;
  private readonly logger: ChannelSessionLogger;
  private readonly healthFailureThreshold: number;
  private readonly healthEvaluator: ChannelHealthEvaluator;
  private readonly onInvalidated:
    | ChannelSessionInvalidationObserver
    | undefined;
  private readonly onPageRefresh:
    | ChannelSessionRefreshObserver
    | undefined;
  private readonly onContainerRestartRequested:
    | ContainerRestartRequestObserver
    | undefined;
  private readonly pageOperationDrainTimeoutMs: number;
  private readonly pointsClaimRetryAttempts: number;
  private readonly pointsClaimRetryDelayMs: number;
  private readonly now: () => Date;

  private currentState: ChannelSessionState = 'stopped';
  private page: Page | undefined;
  private consecutiveHealthFailures = 0;
  private consecutiveRewardFailures = 0;
  private rewardFailureRefreshAttempted = false;
  private containerRestartRequested = false;
  private healthTimer: NodeJS.Timeout | undefined;
  private rewardTimer: NodeJS.Timeout | undefined;
  private playbackOptimizationTimer: NodeJS.Timeout | undefined;
  private pageRefreshTimer: NodeJS.Timeout | undefined;
  private healthFlight: Promise<ChannelHealthResult> | undefined;
  private rewardFlight: Promise<RewardClaimResult> | undefined;
  private pointsFlight: Promise<ChannelSessionPointsResult> | undefined;
  private reloadFlight: Promise<void> | undefined;
  private nextPageRefreshAtMs: number | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private pageOperationTail: Promise<void> = Promise.resolve();
  private startCancellationReason: string | undefined;
  private operationAbortController: AbortController | undefined;

  public constructor(
    private readonly options: DefaultChannelSessionOptions,
  ) {
    validateConfiguredChannel(options.channel, options.config.channels);
    this.channel = options.channel;
    this.targetUrl = createChannelUrl(options.channel);
    this.browserManager = options.browserManager;
    this.rewardClaimer = options.rewardClaimer;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.playbackOptimizer =
      options.playbackOptimizer ??
      new DefaultStreamPlaybackOptimizer(
        options.config.browser,
        this.logger,
      );
    this.healthFailureThreshold = positiveInteger(
      options.healthFailureThreshold,
      DEFAULT_HEALTH_FAILURE_THRESHOLD,
    );
    this.healthEvaluator =
      options.healthEvaluator ?? evaluateChannelHealth;
    this.onInvalidated = options.onInvalidated;
    this.onPageRefresh = options.onPageRefresh;
    this.onContainerRestartRequested =
      options.onContainerRestartRequested;
    this.pageOperationDrainTimeoutMs = positiveInteger(
      options.pageOperationDrainTimeoutMs,
      DEFAULT_PAGE_OPERATION_DRAIN_TIMEOUT_MS,
    );
    this.pointsClaimRetryAttempts = positiveInteger(
      options.pointsClaimRetryAttempts,
      DEFAULT_POINTS_CLAIM_RETRY_ATTEMPTS,
    );
    this.pointsClaimRetryDelayMs = positiveInteger(
      options.pointsClaimRetryDelayMs,
      DEFAULT_POINTS_CLAIM_RETRY_DELAY_MS,
    );
    this.now = options.now ?? (() => new Date());
  }

  public get state(): ChannelSessionState {
    return this.currentState;
  }

  public start(): Promise<void> {
    return this.runLifecycle(async () => {
      if (
        this.currentState === 'starting' ||
        this.currentState === 'watching' ||
        this.currentState === 'recovering' ||
        this.currentState === 'failed'
      ) {
        return;
      }

      this.currentState = 'starting';
      this.startCancellationReason = undefined;
      this.operationAbortController = new AbortController();
      this.consecutiveHealthFailures = 0;
      this.resetRewardFailureRecovery();

      try {
        const page = await this.browserManager.createPage(this.channel);
        this.page = page;
        this.throwIfStartCancelled();
        page.setDefaultNavigationTimeout(
          this.options.config.browser.navigationTimeoutMs,
        );
        await page.goto(this.targetUrl, {
          waitUntil: 'domcontentloaded',
          signal: this.operationAbortController.signal,
        });
        this.throwIfStartCancelled();
        if (!isExpectedChannelUrl(page.url(), this.targetUrl)) {
          throw new Error('頻道頁面導向非預期 Twitch URL');
        }
        await this.acceptContentWarningIfPresent(page, 'start');
        this.throwIfStartCancelled();
        await this.collapseSideNavIfExpanded(page, 'start');
        this.throwIfStartCancelled();
        await this.optimizePlayback(page);
        this.throwIfStartCancelled();

        this.currentState = 'watching';
        this.startTimers();
        safeLog(this.logger, 'info', LOG_EVENTS.WATCH_STARTED, {
          channel: this.channel,
          url: this.targetUrl,
        });
      } catch (error: unknown) {
        this.currentState = 'failed';
        this.clearTimers();
        this.page = undefined;
        await this.closePageForCleanup('start_failure');
        if (this.startCancellationReason !== undefined) {
          safeLog(this.logger, 'debug', 'watch_start_aborted', {
            channel: this.channel,
            reason: this.startCancellationReason,
            outcome: 'aborted',
            error: safeErrorMessage(error),
          });
        } else {
          safeLog(this.logger, 'error', 'watch_start_failed', {
            channel: this.channel,
            error: safeErrorMessage(error),
          });
        }
        throw error;
      }
    });
  }

  public async cancelStart(reason: string): Promise<void> {
    if (this.currentState !== 'starting') {
      return;
    }

    this.startCancellationReason = reason;
    this.abortSessionOperations(reason);
    this.clearTimers();
    this.page = undefined;
    await this.closePageForCleanup('start_cancelled');
  }

  public stop(reason: string): Promise<void> {
    return this.runLifecycle(async () => {
      if (
        this.currentState === 'stopped' ||
        this.currentState === 'stopping'
      ) {
        return;
      }

      this.currentState = 'stopping';
      this.abortSessionOperations(reason);
      this.clearTimers();
      const pageOperationsDrained = await this.drainPageOperations();
      if (!pageOperationsDrained) {
        safeLog(
          this.logger,
          'warn',
          'session_page_operation_drain_timeout',
          {
            channel: this.channel,
            reason,
            timeoutMs: this.pageOperationDrainTimeoutMs,
          },
        );
      }
      this.page = undefined;

      try {
        await this.browserManager.closePage(this.channel);
      } catch (error: unknown) {
        safeLog(this.logger, 'warn', 'watch_stop_cleanup_failed', {
          channel: this.channel,
          reason,
          error: safeErrorMessage(error),
        });
      }

      this.currentState = 'stopped';
      this.startCancellationReason = undefined;
      this.consecutiveHealthFailures = 0;
      this.resetRewardFailureRecovery();
      safeLog(this.logger, 'info', LOG_EVENTS.WATCH_STOPPED, {
        channel: this.channel,
        reason,
      });
    });
  }

  public checkHealth(): Promise<ChannelHealthResult> {
    const existingFlight = this.healthFlight;
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const flight = this.runPageOperation(
      'health',
      async () => this.runHealthCheck(),
    );
    this.healthFlight = flight;
    flight.then(
      () => {
        if (this.healthFlight === flight) {
          this.healthFlight = undefined;
        }
      },
      () => {
        if (this.healthFlight === flight) {
          this.healthFlight = undefined;
        }
      },
    );
    return flight;
  }

  public tickRewardClaim(): Promise<RewardClaimResult> {
    const existingFlight = this.rewardFlight;
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const flight = this.runPageOperation(
      'reward',
      async () => this.runRewardClaim(),
    );
    this.rewardFlight = flight;
    flight.then(
      () => {
        if (this.rewardFlight === flight) {
          this.rewardFlight = undefined;
        }
      },
      () => {
        if (this.rewardFlight === flight) {
          this.rewardFlight = undefined;
        }
      },
    );
    return flight;
  }

  public captureScreenshot(): Promise<Buffer> {
    return this.runPageOperation('screenshot', async () => {
      const page = this.page;
      if (
        page === undefined ||
        page.isClosed() ||
        !this.shouldScheduleWork()
      ) {
        throw new Error('頻道頁面目前無法截圖');
      }

      const screenshot = await page.screenshot({
        type: 'png',
        fullPage: false,
      });
      return Buffer.from(screenshot);
    });
  }

  public getChannelPoints(): Promise<ChannelSessionPointsResult> {
    const existingFlight = this.pointsFlight;
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const flight = this.runPageOperation('points', async () => {
      const page = this.page;
      if (
        page === undefined ||
        page.isClosed() ||
        !this.shouldScheduleWork()
      ) {
        this.logMaintenanceSkipped('points', 'page_unavailable');
        return {
          status: 'unavailable' as const,
          reason: 'page_unavailable' as const,
        };
      }
      return this.readChannelPointsWithClaimRecovery(page);
    });
    this.pointsFlight = flight;
    flight.then(
      () => {
        if (this.pointsFlight === flight) {
          this.pointsFlight = undefined;
        }
      },
      () => {
        if (this.pointsFlight === flight) {
          this.pointsFlight = undefined;
        }
      },
    );
    return flight;
  }

  private async readChannelPointsWithClaimRecovery(
    page: Page,
  ): Promise<ChannelSessionPointsResult> {
    const initial = await readChannelPointsBalance(page);
    if (initial.status === 'available') {
      return initial;
    }

    let claimable = false;
    try {
      claimable = await this.rewardClaimer.hasClaimableBonus(page);
    } catch (error: unknown) {
      safeLog(this.logger, 'debug', 'points_claimable_check_failed', {
        channel: this.channel,
        error: safeErrorMessage(error),
      });
    }
    if (!claimable) {
      return initial;
    }

    safeLog(this.logger, 'info', 'points_claim_before_read', {
      channel: this.channel,
      readFailure: initial.reason,
    });

    try {
      await this.rewardClaimer.claimIfAvailable(page, this.channel);
    } catch (error: unknown) {
      safeLog(this.logger, 'warn', 'points_claim_before_read_failed', {
        channel: this.channel,
        error: safeErrorMessage(error),
      });
    }

    let lastResult: ChannelSessionPointsResult = initial;
    for (
      let attempt = 1;
      attempt <= this.pointsClaimRetryAttempts;
      attempt += 1
    ) {
      await sleep(this.pointsClaimRetryDelayMs);
      lastResult = await readChannelPointsBalance(page);
      if (lastResult.status === 'available') {
        return lastResult;
      }
    }
    return lastResult;
  }

  public getRefreshStatus(): ChannelSessionRefreshStatus {
    const enabled =
      this.options.config.browser.pageRefreshIntervalSeconds > 0;
    const nextRefreshAtMs = this.nextPageRefreshAtMs;
    if (!enabled || nextRefreshAtMs === undefined) {
      return {
        channel: this.channel,
        enabled,
      };
    }

    return {
      channel: this.channel,
      enabled,
      nextRefreshAt: new Date(nextRefreshAtMs).toISOString(),
      secondsUntilRefresh: Math.max(
        0,
        Math.ceil((nextRefreshAtMs - this.now().getTime()) / 1_000),
      ),
    };
  }

  public async refreshNow(): Promise<boolean> {
    const page = this.page;
    if (
      page === undefined ||
      page.isClosed() ||
      !this.shouldScheduleWork()
    ) {
      return false;
    }

    this.notifyPageRefresh('manual_refresh');
    await this.reloadPage(page, 'manual_refresh');
    safeLog(this.logger, 'info', 'page_refreshed', {
      channel: this.channel,
      reason: 'manual_refresh',
    });
    return true;
  }

  private async runHealthCheck(): Promise<ChannelHealthResult> {
    const page = this.page;
    if (
      page === undefined ||
      page.isClosed() ||
      !this.shouldScheduleWork()
    ) {
      this.logMaintenanceSkipped('health', 'page_missing');
      return {
        healthy: false,
        reason:
          this.currentState === 'failed' ? 'page_closed' : 'not_started',
      };
    }

    let result: ChannelHealthResult;
    try {
      result = await this.healthEvaluator(page, this.targetUrl);
    } catch (error: unknown) {
      result = {
        healthy: false,
        reason: 'health_check_error',
        error: safeErrorMessage(error),
      };
    }

    if (
      this.currentState === 'stopping' ||
      this.currentState === 'stopped'
    ) {
      return result;
    }

    if (result.healthy) {
      this.consecutiveHealthFailures = 0;
      this.currentState = 'watching';
      return result;
    }

    await this.handleHealthFailure(page, result);
    return result;
  }

  private async handleHealthFailure(
    page: Page,
    result: Extract<ChannelHealthResult, { healthy: false }>,
  ): Promise<void> {
    this.consecutiveHealthFailures += 1;
    safeLog(this.logger, 'warn', LOG_EVENTS.PAGE_HEALTH_FAILED, {
      channel: this.channel,
      reason: result.reason,
      consecutiveFailures: this.consecutiveHealthFailures,
      ...(result.error === undefined ? {} : { error: result.error }),
    });

    if (
      this.consecutiveHealthFailures >= this.healthFailureThreshold
    ) {
      await this.failSession();
      return;
    }

    this.currentState = 'recovering';
    if (
      result.reason === 'login_required' ||
      result.reason === 'login_missing' ||
      this.consecutiveHealthFailures !== 1 ||
      page.isClosed()
    ) {
      return;
    }

    try {
      await this.reloadDuringPageOperation(page, 'health_failure');
    } catch (error: unknown) {
      safeLog(this.logger, 'warn', 'page_reload_failed', {
        channel: this.channel,
        reason: 'health_failure',
        error: safeErrorMessage(error),
      });
    }
  }

  private async failSession(): Promise<void> {
    this.currentState = 'failed';
    this.abortSessionOperations('health_failure_threshold');
    this.clearTimers();

    this.page = undefined;
    await this.closePageForCleanup('health_failure_threshold');
    this.notifyInvalidated();
  }

  private async runRewardClaim(): Promise<RewardClaimResult> {
    const page = this.page;
    if (
      page === undefined ||
      page.isClosed() ||
      !isExpectedChannelUrl(page.url(), this.targetUrl) ||
      (this.currentState !== 'watching' &&
        this.currentState !== 'recovering')
    ) {
      this.logMaintenanceSkipped('reward', 'page_unavailable');
      return {
        status: 'not_found',
        channel: this.channel,
        checkedAt: this.now().toISOString(),
      };
    }

    let result: RewardClaimResult;
    try {
      result = await this.rewardClaimer.claimIfAvailable(
        page,
        this.channel,
      );
    } catch (error: unknown) {
      const checkedAt = this.now().toISOString();
      const safeError = safeErrorMessage(error);
      safeLog(this.logger, 'warn', LOG_EVENTS.REWARD_CLAIM_FAILED, {
        channel: this.channel,
        checkedAt,
        error: safeError,
      });
      result = {
        status: 'click_failed',
        channel: this.channel,
        checkedAt,
        error: safeError,
      };
    }

    if (this.shouldScheduleWork()) {
      await this.handleRewardClaimResult(page, result);
    }
    return result;
  }

  private async handleRewardClaimResult(
    page: Page,
    result: RewardClaimResult,
  ): Promise<void> {
    if (result.status !== 'click_failed') {
      this.resetRewardFailureRecovery();
      return;
    }

    this.consecutiveRewardFailures += 1;

    if (
      this.consecutiveRewardFailures <
      REWARD_FAILURE_RECOVERY_THRESHOLD
    ) {
      return;
    }

    safeLog(
      this.logger,
      'warn',
      LOG_EVENTS.REWARD_CLAIM_FAILURE_THRESHOLD,
      {
        channel: this.channel,
        consecutiveFailures: this.consecutiveRewardFailures,
        threshold: REWARD_FAILURE_RECOVERY_THRESHOLD,
        recoveryRefreshAttempted: this.rewardFailureRefreshAttempted,
        error: result.error,
      },
    );

    if (!this.rewardFailureRefreshAttempted) {
      await this.refreshAfterRewardFailures(page);
      return;
    }

    this.requestContainerRestartAfterRewardFailures();
  }

  private async refreshAfterRewardFailures(page: Page): Promise<void> {
    this.rewardFailureRefreshAttempted = true;
    safeLog(
      this.logger,
      'warn',
      LOG_EVENTS.REWARD_CLAIM_FAILURE_RECOVERY_REFRESH,
      {
        channel: this.channel,
        threshold: REWARD_FAILURE_RECOVERY_THRESHOLD,
        reason: 'reward_claim_failure_threshold',
      },
    );

    if (page.isClosed()) {
      this.requestContainerRestartAfterRewardFailures();
      return;
    }

    try {
      this.notifyPageRefresh('reward_claim_failure_threshold');
      await this.reloadDuringPageOperation(
        page,
        'reward_claim_failure_threshold',
      );
      this.consecutiveRewardFailures = 0;
      safeLog(this.logger, 'info', 'page_refreshed', {
        channel: this.channel,
        reason: 'reward_claim_failure_threshold',
      });
    } catch (error: unknown) {
      safeLog(this.logger, 'warn', 'page_reload_failed', {
        channel: this.channel,
        reason: 'reward_claim_failure_threshold',
        error: safeErrorMessage(error),
      });
      this.requestContainerRestartAfterRewardFailures();
    }
  }

  private requestContainerRestartAfterRewardFailures(): void {
    if (this.containerRestartRequested) {
      return;
    }

    this.containerRestartRequested = true;
    const request: ContainerRestartRequest = {
      channel: this.channel,
      reason: 'reward_claim_failure_after_refresh',
      consecutiveFailures: this.consecutiveRewardFailures,
      requestedAt: this.now().toISOString(),
    };
    // Canonical container_restart_requested is emitted once by
    // ContainerRestartController; session only escalates via observer.

    const observer = this.onContainerRestartRequested;
    if (observer === undefined) {
      safeLog(this.logger, 'error', LOG_EVENTS.CONTAINER_RESTART_REQUESTED, {
        channel: request.channel,
        reason: request.reason,
        consecutiveFailures: request.consecutiveFailures,
        requestedAt: request.requestedAt,
        source: 'channel_session_reward_no_observer',
      });
      return;
    }

    void Promise.resolve()
      .then(() => observer(request))
      .catch((error: unknown) => {
        safeLog(this.logger, 'error', 'container_restart_request_failed', {
          channel: this.channel,
          reason: request.reason,
          error: safeErrorMessage(error),
        });
      });
  }

  private resetRewardFailureRecovery(): void {
    this.consecutiveRewardFailures = 0;
    this.rewardFailureRefreshAttempted = false;
    this.containerRestartRequested = false;
  }

  private startTimers(): void {
    if (
      this.healthTimer !== undefined ||
      this.rewardTimer !== undefined ||
      this.playbackOptimizationTimer !== undefined ||
      this.pageRefreshTimer !== undefined
    ) {
      return;
    }

    this.scheduleHealthCheck();
    this.scheduleRewardCheck();
    this.schedulePlaybackOptimization();
    this.schedulePageRefresh();
  }

  private clearTimers(): void {
    if (this.healthTimer !== undefined) {
      clearTimeout(this.healthTimer);
      this.healthTimer = undefined;
    }
    if (this.rewardTimer !== undefined) {
      clearTimeout(this.rewardTimer);
      this.rewardTimer = undefined;
    }
    if (this.playbackOptimizationTimer !== undefined) {
      clearTimeout(this.playbackOptimizationTimer);
      this.playbackOptimizationTimer = undefined;
    }
    if (this.pageRefreshTimer !== undefined) {
      clearTimeout(this.pageRefreshTimer);
      this.pageRefreshTimer = undefined;
    }
    this.nextPageRefreshAtMs = undefined;
  }

  private async optimizePlayback(page: Page): Promise<void> {
    try {
      await this.playbackOptimizer.optimize(page, this.channel);
    } catch (error: unknown) {
      safeLog(this.logger, 'debug', 'stream_playback_optimization_failed', {
        channel: this.channel,
        error: safeErrorMessage(error),
      });
    }
  }

  private async acceptContentWarningIfPresent(
    page: Page,
    reason: string,
  ): Promise<void> {
    const result = await acceptContentWarning(page);
    if (result === 'not_present') {
      return;
    }
    if (result === 'accepted') {
      safeLog(this.logger, 'info', 'content_warning_accepted', {
        channel: this.channel,
        reason,
      });
      return;
    }
    safeLog(this.logger, 'warn', 'content_warning_accept_failed', {
      channel: this.channel,
      reason,
    });
  }

  private async collapseSideNavIfExpanded(
    page: Page,
    reason: string,
  ): Promise<void> {
    const result = await collapseSideNav(page);
    if (result === 'collapsed') {
      safeLog(this.logger, 'debug', 'side_nav_collapsed', {
        channel: this.channel,
        reason,
      });
      return;
    }
    if (result === 'failed') {
      safeLog(this.logger, 'debug', 'side_nav_collapse_skipped', {
        channel: this.channel,
        reason,
      });
    }
  }

  private scheduleHealthCheck(): void {
    if (!this.shouldScheduleWork()) {
      return;
    }
    this.healthTimer = setTimeout(() => {
      this.healthTimer = undefined;
      void this.checkHealth()
        .catch((error: unknown) => {
          safeLog(this.logger, 'error', 'page_health_timer_failed', {
            channel: this.channel,
            error: safeErrorMessage(error),
          });
        })
        .finally(() => {
          this.scheduleHealthCheck();
        });
    }, this.timerDelay(
      this.options.config.browser.pageHealthCheckIntervalSeconds,
      'health',
    ));
  }

  private scheduleRewardCheck(): void {
    if (!this.shouldScheduleWork()) {
      return;
    }
    this.rewardTimer = setTimeout(() => {
      this.rewardTimer = undefined;
      void this.tickRewardClaim()
        .catch((error: unknown) => {
          safeLog(this.logger, 'error', 'reward_timer_failed', {
            channel: this.channel,
            error: safeErrorMessage(error),
          });
        })
        .finally(() => {
          this.scheduleRewardCheck();
        });
    }, this.timerDelay(
      this.options.config.browser.rewardCheckIntervalSeconds,
      'reward',
    ));
  }

  private schedulePlaybackOptimization(): void {
    if (!this.shouldScheduleWork()) {
      return;
    }
    this.playbackOptimizationTimer = setTimeout(() => {
      this.playbackOptimizationTimer = undefined;
      const page = this.page;
      let work: Promise<void>;
      if (page === undefined || page.isClosed()) {
        this.logMaintenanceSkipped('playback', 'page_unavailable');
        work = Promise.resolve();
      } else {
        work = this.runPageOperation('playback', async () => {
          if (
            this.page !== page ||
            page.isClosed() ||
            !this.shouldScheduleWork()
          ) {
            this.logMaintenanceSkipped('playback', 'page_unavailable');
            return;
          }
          await this.optimizePlayback(page);
        });
      }
      void work.finally(() => {
        this.schedulePlaybackOptimization();
      });
    }, this.timerDelay(
      this.options.config.browser.enforceStreamQualitySeconds,
      'playback',
    ));
  }

  private schedulePageRefresh(): void {
    if (
      !this.shouldScheduleWork() ||
      this.options.config.browser.pageRefreshIntervalSeconds <= 0
    ) {
      return;
    }
    const delay = this.pageRefreshDelay();
    this.nextPageRefreshAtMs = this.now().getTime() + delay;
    this.pageRefreshTimer = setTimeout(() => {
      this.pageRefreshTimer = undefined;
      this.nextPageRefreshAtMs = undefined;
      void this.refreshPage()
        .catch((error: unknown) => {
          safeLog(this.logger, 'warn', 'page_refresh_failed', {
            channel: this.channel,
            error: safeErrorMessage(error),
          });
        })
        .finally(() => {
          this.schedulePageRefresh();
        });
    }, delay);
  }

  private async refreshPage(): Promise<void> {
    const page = this.page;
    if (
      page === undefined ||
      page.isClosed() ||
      !this.shouldScheduleWork()
    ) {
      return;
    }

    this.notifyPageRefresh('scheduled_refresh');
    await this.reloadPage(page, 'scheduled_refresh');
    safeLog(this.logger, 'info', 'page_refreshed', {
      channel: this.channel,
      reason: 'scheduled_refresh',
    });
  }

  private reloadPage(page: Page, reason: string): Promise<void> {
    const existingFlight = this.reloadFlight;
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const flight = this.runPageOperation('reload', async () => {
      if (
        this.page !== page ||
        page.isClosed() ||
        !this.shouldScheduleWork()
      ) {
        this.logMaintenanceSkipped('reload', 'page_unavailable');
        return;
      }
      await this.runPageReload(page, reason);
    });
    return this.trackReloadFlight(flight);
  }

  private reloadDuringPageOperation(
    page: Page,
    reason: string,
  ): Promise<void> {
    if (this.reloadFlight !== undefined) {
      this.logMaintenanceSkipped('reload', 'reload_already_queued');
      return Promise.resolve();
    }

    return this.trackReloadFlight(this.runPageReload(page, reason));
  }

  private trackReloadFlight(flight: Promise<void>): Promise<void> {
    this.reloadFlight = flight;
    flight.then(
      () => {
        if (this.reloadFlight === flight) {
          this.reloadFlight = undefined;
        }
      },
      () => {
        if (this.reloadFlight === flight) {
          this.reloadFlight = undefined;
        }
      },
    );
    return flight;
  }

  private async runPageReload(page: Page, reason: string): Promise<void> {
    const abortController = this.operationAbortController;
    await page.reload({
      waitUntil: 'domcontentloaded',
      ...(abortController === undefined
        ? {}
        : { signal: abortController.signal }),
    });
    await this.acceptContentWarningIfPresent(page, reason);
    await this.collapseSideNavIfExpanded(page, reason);
    await this.optimizePlayback(page);
    safeLog(this.logger, 'debug', 'page_reloaded', {
      channel: this.channel,
      reason,
    });
  }

  private timerDelay(intervalSeconds: number, task: string): number {
    return Math.min(
      MAX_TIMER_DELAY_MS,
      intervalSeconds * 1_000 +
        stableJitter(`${this.channel}:${task}`, MAX_TIMER_JITTER_MS),
    );
  }

  private pageRefreshDelay(): number {
    const intervalMs =
      this.options.config.browser.pageRefreshIntervalSeconds * 1_000;
    const refreshJitterMs = Math.min(
      MAX_PAGE_REFRESH_JITTER_MS,
      Math.max(MAX_TIMER_JITTER_MS, Math.floor(intervalMs * 0.2)),
    );
    return Math.min(
      MAX_TIMER_DELAY_MS,
      intervalMs +
        stableJitter(`${this.channel}:page-refresh`, refreshJitterMs),
    );
  }

  private throwIfStartCancelled(): void {
    if (this.startCancellationReason !== undefined) {
      throw new Error(
        `Session start cancelled: ${this.startCancellationReason}`,
      );
    }
  }

  private abortSessionOperations(reason: string): void {
    const controller = this.operationAbortController;
    if (controller === undefined || controller.signal.aborted) {
      return;
    }
    controller.abort(reason);
    safeLog(this.logger, 'debug', 'session_operation_aborted', {
      channel: this.channel,
      reason,
      outcome: 'aborted',
    });
  }

  private async drainPageOperations(): Promise<boolean> {
    const operations = this.pageOperationTail.catch(() => undefined);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve(false),
        this.pageOperationDrainTimeoutMs,
      );
      timeoutHandle.unref?.();
    });

    try {
      return await Promise.race([
        operations.then(() => true as const),
        timeout,
      ]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private shouldScheduleWork(): boolean {
    return (
      this.currentState === 'watching' ||
      this.currentState === 'recovering'
    );
  }

  private async closePageForCleanup(reason: string): Promise<void> {
    try {
      await this.browserManager.closePage(this.channel);
    } catch (error: unknown) {
      safeLog(this.logger, 'warn', 'watch_page_cleanup_failed', {
        channel: this.channel,
        reason,
        error: safeErrorMessage(error),
      });
    }
  }

  private notifyInvalidated(): void {
    const observer = this.onInvalidated;
    if (observer === undefined) {
      return;
    }

    void Promise.resolve()
      .then(() => observer(this.channel, 'health_failure_threshold'))
      .catch((error: unknown) => {
        safeLog(this.logger, 'warn', 'session_invalidation_failed', {
          channel: this.channel,
          reason: 'health_failure_threshold',
          error: safeErrorMessage(error),
        });
      });
  }

  private notifyPageRefresh(reason: ChannelSessionRefreshReason): void {
    const observer = this.onPageRefresh;
    if (observer === undefined) {
      return;
    }

    const event: ChannelSessionRefreshEvent = {
      channel: this.channel,
      reason,
      startedAt: this.now().toISOString(),
    };
    void Promise.resolve()
      .then(() => observer(event))
      .catch((error: unknown) => {
        safeLog(this.logger, 'warn', 'page_refresh_notification_failed', {
          channel: this.channel,
          reason: event.reason,
          error: safeErrorMessage(error),
        });
      });
  }

  private async runLifecycle<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleTail;
    let release: (() => void) | undefined;
    this.lifecycleTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async runPageOperation<T>(
    task: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queuedAt = performance.now();
    const previous = this.pageOperationTail;
    let release: (() => void) | undefined;
    this.pageOperationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);
    const startedAt = performance.now();
    let outcome = 'completed';
    try {
      return await operation();
    } catch (error: unknown) {
      outcome = 'failed';
      throw error;
    } finally {
      const completedAt = performance.now();
      safeLog(this.logger, 'debug', 'session_maintenance_completed', {
        channel: this.channel,
        task,
        outcome,
        queuedMs: Math.round(startedAt - queuedAt),
        durationMs: Math.round(completedAt - startedAt),
      });
      release?.();
    }
  }

  private logMaintenanceSkipped(task: string, reason: string): void {
    safeLog(this.logger, 'debug', 'session_maintenance_skipped', {
      channel: this.channel,
      task,
      reason,
    });
  }
}

function validateConfiguredChannel(
  channel: string,
  configuredChannels: readonly string[],
): void {
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error('Channel 必須是 1 到 25 字元的英數字或底線');
  }

  const normalizedChannel = channel.toLocaleLowerCase('en-US');
  const isConfigured = configuredChannels.some(
    (configuredChannel) =>
      configuredChannel.toLocaleLowerCase('en-US') === normalizedChannel,
  );
  if (!isConfigured) {
    throw new Error(`Channel "${channel}" 不在已驗證的設定清單中`);
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
