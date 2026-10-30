import {
  redactSensitiveString,
  type LogFields,
  type Logger,
} from '../logging/index.js';
import type {
  ChannelSession,
  ChannelSessionFactory,
  ChannelSessionPointsResult,
  ChannelSessionRefreshStatus,
} from '../browser/ChannelSession.js';
import type { BrowserNavigationOutcome } from '../browser/BrowserManager.js';
import type { ChannelRecoveryPolicy } from './ChannelRecoveryPolicy.js';

export type {
  ChannelSession,
  ChannelSessionFactory,
  ChannelSessionPointsResult,
  ChannelSessionRefreshStatus,
} from '../browser/ChannelSession.js';

export interface SessionManager {
  reconcile(activeChannels: readonly string[]): Promise<void>;
  updateConfiguredChannels(channels: readonly string[]): void;
  cancelPendingStarts(reason: string): Promise<void>;
  stopAll(reason: string): Promise<void>;
  invalidate(channel: string, reason: string): Promise<void>;
  getActiveChannels(): string[];
  getRefreshStatuses(): readonly ChannelSessionRefreshStatus[];
  refreshPages(channel?: string): Promise<readonly SessionRefreshResult[]>;
  captureScreenshot(channel?: string): Promise<SessionScreenshot | undefined>;
  getChannelPoints(
    channel?: string,
  ): Promise<readonly SessionChannelPointsResult[]>;
}

export interface SessionRefreshResult {
  readonly channel: string;
  readonly status: 'refreshed' | 'unavailable' | 'failed';
  readonly error?: string;
}

export interface SessionScreenshot {
  readonly channel: string;
  readonly image: Buffer;
}

export type SessionChannelPointsResult =
  | {
      readonly channel: string;
      readonly status: 'available';
      readonly balance: number;
      readonly displayValue: string;
    }
  | {
      readonly channel: string;
      readonly status: 'unavailable';
      readonly reason:
        | Extract<
            ChannelSessionPointsResult,
            { status: 'unavailable' }
          >['reason']
        | 'failed';
    };

export type SessionManagerLogger = Pick<Logger, 'debug' | 'error' | 'warn'>;
export type SessionManagerSleep = (milliseconds: number) => Promise<void>;
export type SessionNavigationOutcomeObserver = (
  outcomes: readonly BrowserNavigationOutcome[],
) => Promise<void> | void;

export interface SessionManagerDependencies {
  readonly logger?: SessionManagerLogger;
  readonly sleep?: SessionManagerSleep;
  readonly startRetryAttempts?: number;
  readonly startRetryDelayMs?: number;
  readonly startStaggerMs?: number;
  readonly sessionOperationTimeoutMs?: number;
  readonly onNavigationOutcomes?: SessionNavigationOutcomeObserver;
  readonly recoveryPolicy?: ChannelRecoveryPolicy;
  readonly configuredChannels?: readonly string[];
}

const NOOP_LOGGER: SessionManagerLogger = {
  debug(): void {},
  error(): void {},
  warn(): void {},
};
const DEFAULT_START_RETRY_ATTEMPTS = 0;
const DEFAULT_START_RETRY_DELAY_MS = 0;
const DEFAULT_START_STAGGER_MS = 0;
const DEFAULT_SESSION_OPERATION_TIMEOUT_MS = 60_000;

class SessionOperationTimeoutError extends Error {
  public constructor(
    public readonly event: string,
    timeoutMs: number,
  ) {
    super(`${event} after ${timeoutMs}ms`);
    this.name = 'SessionOperationTimeoutError';
  }
}

type RecoveryProbeGate =
  | { readonly allowed: false }
  | { readonly allowed: true; readonly recoveryGeneration?: number };

export class DefaultSessionManager implements SessionManager {
  private readonly sessions = new Map<string, ChannelSession>();
  private readonly logger: SessionManagerLogger;
  private readonly sleep: SessionManagerSleep;
  private readonly maxStartAttempts: number;
  private readonly startRetryDelayMs: number;
  private readonly startStaggerMs: number;
  private readonly sessionOperationTimeoutMs: number;
  private readonly onNavigationOutcomes:
    | SessionNavigationOutcomeObserver
    | undefined;
  private readonly channelOperationTails = new Map<string, Promise<void>>();
  private readonly startingSessions = new Map<string, ChannelSession>();
  private readonly cancelledStartSessions = new WeakSet<ChannelSession>();
  private shutdownRequested = false;
  private readonly recoveryPolicy: ChannelRecoveryPolicy | undefined;
  private configuredChannels: Set<string>;
  private readonly stableRecoveryGenerations = new Map<string, number>();

  public constructor(
    private readonly factory: ChannelSessionFactory,
    dependencies: SessionManagerDependencies = {},
  ) {
    this.logger = dependencies.logger ?? NOOP_LOGGER;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.maxStartAttempts =
      1 + normalizeNonNegativeInteger(
        dependencies.startRetryAttempts,
        DEFAULT_START_RETRY_ATTEMPTS,
      );
    this.startRetryDelayMs = normalizeNonNegativeInteger(
      dependencies.startRetryDelayMs,
      DEFAULT_START_RETRY_DELAY_MS,
    );
    this.startStaggerMs = normalizeNonNegativeInteger(
      dependencies.startStaggerMs,
      DEFAULT_START_STAGGER_MS,
    );
    this.sessionOperationTimeoutMs = normalizePositiveInteger(
      dependencies.sessionOperationTimeoutMs,
      DEFAULT_SESSION_OPERATION_TIMEOUT_MS,
    );
    this.onNavigationOutcomes = dependencies.onNavigationOutcomes;
    this.recoveryPolicy = dependencies.recoveryPolicy;
    this.configuredChannels = new Set(
      (dependencies.configuredChannels ?? []).map(normalizeChannel),
    );
  }

  public async reconcile(activeChannels: readonly string[]): Promise<void> {
    if (this.shutdownRequested) {
      return;
    }
    this.recordStableRecoveryResets();
    const desiredChannels = uniqueChannels(activeChannels);
    const navigationOutcomes: BrowserNavigationOutcome[] = [];
    const startedAtMs = Date.now();
    this.safeLog('debug', 'session_reconcile_started', {
      desiredChannels,
      activeBefore: this.getActiveChannels(),
    });

    const desiredChannelSet = new Set(desiredChannels);
    const channelsToStop = [...this.sessions.keys()].filter(
      (channel) => !desiredChannelSet.has(channel),
    );
    const stopResults = await Promise.all(
      channelsToStop.map((channel) =>
        this.runChannelExclusive(channel, async () => {
          const session = this.sessions.get(channel);
          if (session === undefined) {
            return false;
          }
          this.sessions.delete(channel);
          await this.stopSession(session, channel, 'inactive');
          return true;
        }),
      ),
    );

    let startedCount = 0;
    let hasAttemptedStart = false;
    for (const channel of desiredChannels) {
      if (this.shutdownRequested || this.sessions.has(channel)) {
        continue;
      }
      if (hasAttemptedStart && this.startStaggerMs > 0) {
        await this.sleep(this.startStaggerMs);
      }
      const navigationOutcome = await this.runChannelExclusive(
        channel,
        async () => {
          if (this.shutdownRequested || this.sessions.has(channel)) {
            return undefined;
          }
          const gate = this.beginRecoveryProbe(channel);
          if (!gate.allowed) {
            return undefined;
          }
          return this.startSession(channel, gate.recoveryGeneration);
        },
      );
      if (navigationOutcome !== undefined) {
        navigationOutcomes.push(navigationOutcome);
      }
      if (this.sessions.has(channel)) {
        startedCount += 1;
      }
      hasAttemptedStart = true;
    }

    this.reorderSessions(desiredChannels);
    this.safeLog('debug', 'session_reconcile_completed', {
      desiredChannels,
      activeAfter: this.getActiveChannels(),
      stoppedCount: stopResults.filter(Boolean).length,
      startedCount,
      durationMs: Date.now() - startedAtMs,
    });

    await this.notifyNavigationOutcomes(navigationOutcomes);
  }

  public updateConfiguredChannels(channels: readonly string[]): void {
    const nextChannels = new Set(channels.map(normalizeChannel));
    for (const channel of this.configuredChannels) {
      if (!nextChannels.has(channel)) {
        this.recoveryPolicy?.removeChannel(channel);
        this.stableRecoveryGenerations.delete(channel);
      }
    }
    this.configuredChannels = nextChannels;
  }

  public async cancelPendingStarts(reason: string): Promise<void> {
    this.shutdownRequested = true;
    await Promise.all(
      [...this.startingSessions].map(([channel, session]) =>
        this.cancelStart(session, channel, reason),
      ),
    );
  }

  public async stopAll(reason: string): Promise<void> {
    this.shutdownRequested = true;
    const sessions = [...this.sessions];
    const startingChannels = [...this.startingSessions.keys()];
    this.sessions.clear();
    const cancellation = this.cancelPendingStarts(reason);
    const stops = sessions.map(([channel, session]) =>
      this.runChannelExclusive(channel, () =>
        this.stopSession(session, channel, reason),
      ),
    );
    const pendingStarts = startingChannels.map((channel) =>
      this.runChannelExclusive(channel, async () => undefined),
    );
    try {
      await this.withSessionOperationTimeout(
        Promise.all([cancellation, ...stops, ...pendingStarts]),
        'session_stop_all_timeout',
        { reason },
      );
    } catch {
      // Shutdown 返回後，各頻道的 lifecycle timeout 仍會各自完成清理。
    }
  }

  public async invalidate(channel: string, reason: string): Promise<void> {
    const startedAtMs = Date.now();
    this.safeLog('debug', 'session_invalidate_started', {
      channel,
      reason,
      activeBefore: this.getActiveChannels(),
    });

    await this.runChannelExclusive(channel, async () => {
      const session = this.sessions.get(channel);
      if (session === undefined) {
        this.safeLog('debug', 'session_invalidate_completed', {
          channel,
          reason,
          removed: false,
          activeAfter: this.getActiveChannels(),
          durationMs: Date.now() - startedAtMs,
        });
        return;
      }

      if (reason === 'page_crashed' || reason === 'page_closed') {
        const decision = this.recoveryPolicy?.recordPageCrash(channel);
        if (decision?.status === 'quarantined') {
          this.safeLog('warn', 'channel_recovery_quarantined', {
            channel,
            retryAtMs: decision.retryAtMs,
            reason,
            consecutivePageCrashes: decision.consecutivePageCrashes,
          });
        }
      }

      if (reason === 'health_failure_threshold') {
        const decision = this.recoveryPolicy?.recordStartFailure(channel);
        if (decision !== undefined) {
          this.safeLog('warn', 'channel_health_recovery_backoff', {
            channel,
            reason,
            retryAtMs: decision.retryAtMs,
            consecutiveFailures: decision.consecutiveStartFailures,
          });
        }
      }

      this.sessions.delete(channel);
      await this.stopSession(session, channel, reason);
      this.safeLog('debug', 'session_invalidate_completed', {
        channel,
        reason,
        removed: true,
        activeAfter: this.getActiveChannels(),
        durationMs: Date.now() - startedAtMs,
      });
    });
  }

  public getActiveChannels(): string[] {
    return [...this.sessions.keys()];
  }

  public getRefreshStatuses(): readonly ChannelSessionRefreshStatus[] {
    return [...this.sessions.values()].map((session) =>
      session.getRefreshStatus(),
    );
  }

  public async refreshPages(
    requestedChannel?: string,
  ): Promise<readonly SessionRefreshResult[]> {
    const entries = requestedChannel === undefined
      ? [...this.sessions]
      : optionalEntry(findSession(this.sessions, requestedChannel));

    const results: SessionRefreshResult[] = [];
    for (const [channel, session] of entries) {
      try {
        const refreshed = await session.refreshNow();
        results.push({
          channel,
          status: refreshed ? 'refreshed' : 'unavailable',
        });
      } catch (error: unknown) {
        const safeError = safeErrorMessage(error);
        this.safeLog('warn', 'session_manual_refresh_failed', {
          channel,
          error: safeError,
        });
        results.push({
          channel,
          status: 'failed',
          error: safeError,
        });
      }
    }
    return results;
  }

  public async captureScreenshot(
    requestedChannel?: string,
  ): Promise<SessionScreenshot | undefined> {
    const entries = requestedChannel === undefined
      ? [...this.sessions]
      : optionalEntry(findSession(this.sessions, requestedChannel));

    for (const [channel, session] of entries) {
      try {
        return {
          channel,
          image: await session.captureScreenshot(),
        };
      } catch (error: unknown) {
        this.safeLog('warn', 'session_screenshot_failed', {
          channel,
          error: safeErrorMessage(error),
        });
      }
    }

    return undefined;
  }

  public async getChannelPoints(
    requestedChannel?: string,
  ): Promise<readonly SessionChannelPointsResult[]> {
    const entries = requestedChannel === undefined
      ? [...this.sessions]
      : optionalEntry(findSession(this.sessions, requestedChannel));
    const results: SessionChannelPointsResult[] = [];

    for (const [channel, session] of entries) {
      try {
        const result = await session.getChannelPoints();
        results.push({ channel, ...result });
      } catch (error: unknown) {
        this.safeLog('warn', 'session_channel_points_failed', {
          channel,
          error: safeErrorMessage(error),
        });
        results.push({ channel, status: 'unavailable', reason: 'failed' });
      }
    }

    return results;
  }

  private async startSession(
    channel: string,
    recoveryGeneration?: number,
  ): Promise<BrowserNavigationOutcome | undefined> {
    for (let attempt = 1; attempt <= this.maxStartAttempts; attempt += 1) {
      let session: ChannelSession | undefined;
      const startedAtMs = Date.now();

      try {
        this.safeLog('debug', 'session_start_attempt_started', {
          channel,
          attempt,
          maxAttempts: this.maxStartAttempts,
        });
        session = await this.factory.create(channel);
        this.startingSessions.set(channel, session);
        await this.withSessionOperationTimeout(
          session.start(),
          'session_start_timeout',
          { channel, attempt },
        );
        if (this.shutdownRequested) {
          await this.stopSession(session, channel, 'shutdown');
          return undefined;
        }
        this.sessions.set(channel, session);
        if (
          recoveryGeneration !== undefined &&
          this.recoveryPolicy?.markStable(channel, recoveryGeneration) === true
        ) {
          this.stableRecoveryGenerations.set(
            normalizeChannel(channel),
            recoveryGeneration,
          );
        }
        this.safeLog('debug', 'session_start_attempt_completed', {
          channel,
          attempt,
          durationMs: Date.now() - startedAtMs,
        });
        return { channel, status: 'succeeded' };
      } catch (error: unknown) {
        const safeError = safeErrorMessage(error);

        if (session !== undefined) {
          if (
            error instanceof SessionOperationTimeoutError &&
            error.event === 'session_start_timeout'
          ) {
            await this.cancelTimedOutStart(session, channel);
          }
          await this.cleanupFailedStart(session, channel);
        }

        const shouldRetry =
          attempt < this.maxStartAttempts &&
          isRetriableSessionStartError(safeError);

        if (!shouldRetry) {
          if (isRecoverableSessionStartError(safeError)) {
            this.recoveryPolicy?.recordStartFailure(channel);
          } else if (recoveryGeneration !== undefined) {
            this.recoveryPolicy?.cancelProbe(channel, recoveryGeneration);
          }
          this.safeLog('error', 'session_start_failed', {
            channel,
            error: safeError,
          });
          return isNavigationTimeoutError(safeError)
            ? { channel, status: 'timed_out' }
            : undefined;
        }

        this.safeLog('warn', 'session_start_retry_scheduled', {
          channel,
          attempt,
          retryInMs: this.startRetryDelayMs,
          error: safeError,
        });

        if (this.startRetryDelayMs > 0) {
          await this.sleep(this.startRetryDelayMs);
        }
      } finally {
        if (
          session !== undefined &&
          this.startingSessions.get(channel) === session
        ) {
          this.startingSessions.delete(channel);
        }
      }
    }

    return undefined;
  }

  private async notifyNavigationOutcomes(
    outcomes: readonly BrowserNavigationOutcome[],
  ): Promise<void> {
    const observer = this.onNavigationOutcomes;
    if (observer === undefined || outcomes.length === 0) {
      return;
    }

    try {
      await observer(outcomes);
    } catch (error: unknown) {
      this.safeLog('warn', 'session_navigation_outcome_observer_failed', {
        error: safeErrorMessage(error),
      });
    }
  }

  private beginRecoveryProbe(channel: string): RecoveryProbeGate {
    const policy = this.recoveryPolicy;
    if (policy === undefined) {
      return { allowed: true };
    }
    const state = policy.getState(channel);
    const hasRecoveryHistory =
      state.consecutivePageCrashes > 0 ||
      state.consecutiveStartFailures > 0;
    if (!hasRecoveryHistory) {
      return { allowed: true };
    }

    const availability = policy.getAvailability(channel);
    if (availability.status === 'quarantined') {
      this.safeLog('warn', 'channel_recovery_quarantined', {
        channel,
        retryAtMs: availability.retryAtMs,
        reason: 'quarantine_active',
      });
      return { allowed: false };
    }
    if (availability.status !== 'eligible') {
      this.safeLog('debug', 'channel_recovery_deferred', {
        channel,
        reason: availability.status,
        ...('retryAtMs' in availability
          ? { retryAtMs: availability.retryAtMs }
          : {}),
      });
      return { allowed: false };
    }

    const probe = policy.beginProbe(channel);
    if (probe.status !== 'started') {
      this.safeLog('debug', 'channel_recovery_deferred', {
        channel,
        reason: probe.status,
      });
      return { allowed: false };
    }
    this.safeLog('debug', 'channel_recovery_probe_started', {
      channel,
      recoveryGeneration: probe.recoveryGeneration,
    });
    return {
      allowed: true,
      recoveryGeneration: probe.recoveryGeneration,
    };
  }

  private recordStableRecoveryResets(): void {
    const policy = this.recoveryPolicy;
    if (policy === undefined) {
      return;
    }
    for (const [channel, recoveryGeneration] of this.stableRecoveryGenerations) {
      const state = policy.getState(channel);
      if (
        state.recoveryGeneration === recoveryGeneration &&
        state.consecutivePageCrashes === 0 &&
        state.consecutiveStartFailures === 0 &&
        state.stableSinceMs === undefined
      ) {
        this.stableRecoveryGenerations.delete(channel);
        this.safeLog('debug', 'channel_recovery_reset', {
          channel,
          recoveryGeneration,
        });
      }
    }
  }

  private async cancelTimedOutStart(
    session: ChannelSession,
    channel: string,
  ): Promise<void> {
    await this.cancelStart(session, channel, 'start_timeout');
  }

  private async cancelStart(
    session: ChannelSession,
    channel: string,
    reason: string,
  ): Promise<void> {
    if (session.cancelStart === undefined) {
      return;
    }
    if (this.cancelledStartSessions.has(session)) {
      return;
    }
    this.cancelledStartSessions.add(session);

    try {
      await this.withSessionOperationTimeout(
        session.cancelStart(reason),
        'session_start_cancel_timeout',
        { channel, reason },
      );
    } catch (error: unknown) {
      this.safeLog('warn', 'session_start_cancel_failed', {
        channel,
        error: safeErrorMessage(error),
      });
    }
  }

  private async cleanupFailedStart(
    session: ChannelSession,
    channel: string,
  ): Promise<void> {
    await this.stopSession(session, channel, 'start_failed');
  }

  private async stopSession(
    session: ChannelSession,
    channel: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.withSessionOperationTimeout(
        session.stop(reason),
        'session_stop_timeout',
        { channel, reason },
      );
    } catch (error: unknown) {
      this.safeLog('warn', 'session_stop_failed', {
        channel,
        reason,
        error: safeErrorMessage(error),
      });
    }
  }

  private async withSessionOperationTimeout<T>(
    operation: Promise<T>,
    timeoutEvent: string,
    fields: LogFields,
  ): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    operation.catch(() => undefined);

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        this.safeLog('warn', timeoutEvent, {
          ...fields,
          timeoutMs: this.sessionOperationTimeoutMs,
        });
        reject(
          new SessionOperationTimeoutError(
            timeoutEvent,
            this.sessionOperationTimeoutMs,
          ),
        );
      }, this.sessionOperationTimeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private reorderSessions(desiredChannels: readonly string[]): void {
    const orderedSessions = desiredChannels.flatMap((channel) => {
      const session = this.sessions.get(channel);
      return session === undefined ? [] : [[channel, session] as const];
    });

    this.sessions.clear();
    for (const [channel, session] of orderedSessions) {
      this.sessions.set(channel, session);
    }
  }

  private async runChannelExclusive<T>(
    channel: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.channelOperationTails.get(channel) ??
      Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.channelOperationTails.set(channel, tail);
    void tail.then(() => {
      if (this.channelOperationTails.get(channel) === tail) {
        this.channelOperationTails.delete(channel);
      }
    });
    return result;
  }

  private safeLog(
    level: keyof SessionManagerLogger,
    event: string,
    fields: LogFields,
  ): void {
    try {
      this.logger[level](event, fields);
    } catch {
      // Logging failure must not break session lifecycle cleanup.
    }
  }
}

function uniqueChannels(channels: readonly string[]): string[] {
  return [...new Set(channels)];
}

function findSession(
  sessions: ReadonlyMap<string, ChannelSession>,
  requestedChannel: string,
): readonly [string, ChannelSession] | undefined {
  const normalized = requestedChannel.trim().toLocaleLowerCase('en-US');
  return [...sessions].find(
    ([channel]) => channel.toLocaleLowerCase('en-US') === normalized,
  );
}

function optionalEntry(
  entry: readonly [string, ChannelSession] | undefined,
): readonly (readonly [string, ChannelSession])[] {
  return entry === undefined ? [] : [entry];
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    Math.trunc(value) <= 0
  ) {
    return fallback;
  }

  return Math.trunc(value);
}

function isRetriableSessionStartError(message: string): boolean {
  return !isFatalPrerequisiteError(message) &&
    isRecoverableSessionStartError(message);
}

function isRecoverableSessionStartError(message: string): boolean {
  return /Target page, context or browser has been closed/iu.test(message) ||
    /browser(?: manager)? (?:has been )?closed/iu.test(message) ||
    /context .*closed/iu.test(message) ||
    /page .*closed/iu.test(message) ||
    /target .*crashed/iu.test(message) ||
    /page\.goto: Timeout \d+ms exceeded/iu.test(message) ||
    /導向非預期 Twitch URL/iu.test(message) ||
    /Browser Manager 尚未啟動/iu.test(message);
}

function isFatalPrerequisiteError(message: string): boolean {
  return /auth(?:entication|orization)? failed/iu.test(message) ||
    /configuration (?:error|invalid)/iu.test(message) ||
    /storage[\s_-]?state (?:error|invalid|missing)/iu.test(message);
}

function isNavigationTimeoutError(message: string): boolean {
  return /page\.goto: Timeout \d+ms exceeded/iu.test(message);
}

function normalizeChannel(channel: string): string {
  return channel.toLocaleLowerCase('en-US');
}

function safeErrorMessage(error: unknown): string {
  let message = 'Unknown session lifecycle failure';

  try {
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error !== undefined && error !== null) {
      message = String(error);
    }
  } catch {
    message = 'Unserializable session lifecycle failure';
  }

  return redactSensitiveString(message);
}
