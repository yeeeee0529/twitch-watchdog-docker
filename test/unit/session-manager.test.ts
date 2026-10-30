import { describe, expect, it, vi } from 'vitest';

import {
  DefaultSessionManager,
  type ChannelSession,
  type ChannelSessionFactory,
  type ChannelSessionPointsResult,
  type SessionManagerLogger,
} from '../../src/sessions/SessionManager.js';
import { ChannelRecoveryPolicy } from '../../src/sessions/ChannelRecoveryPolicy.js';
import {
  createDefaultBrowserRecovery,
  createDefaultBrowserSessionStart,
} from '../helpers/test-config.js';

interface TestSession extends ChannelSession {
  readonly secret: string;
}

function createSession(
  channel: string,
  options: {
    readonly onStart?: () => Promise<void>;
    readonly onCancelStart?: (reason: string) => Promise<void>;
    readonly onStop?: (reason: string) => Promise<void>;
    readonly screenshot?: Buffer;
    readonly channelPoints?: ChannelSessionPointsResult;
    readonly refreshNow?: () => Promise<boolean>;
    readonly refreshStatus?: {
      readonly enabled: boolean;
      readonly nextRefreshAt?: string;
      readonly secondsUntilRefresh?: number;
    };
  } = {},
): TestSession {
  return {
    channel,
    secret: `session-secret-${channel}`,
    start: vi.fn(options.onStart ?? (async () => undefined)),
    cancelStart: vi.fn(
      options.onCancelStart ?? (async () => undefined),
    ),
    stop: vi.fn(options.onStop ?? (async () => undefined)),
    checkHealth: vi.fn(async () => ({ healthy: true, reason: 'live' })),
    tickRewardClaim: vi.fn(async () => ({
      status: 'not_found',
      channel,
      checkedAt: '2026-06-14T12:00:00.000Z',
    })),
    captureScreenshot: vi.fn(async () =>
      options.screenshot ?? Buffer.from(`screenshot:${channel}`)),
    getChannelPoints: vi.fn(async () =>
      options.channelPoints ?? {
        status: 'unavailable' as const,
        reason: 'not_found' as const,
      }),
    refreshNow: vi.fn(options.refreshNow ?? (async () => true)),
    getRefreshStatus: vi.fn(() => ({
      channel,
      enabled: options.refreshStatus?.enabled ?? false,
      ...(options.refreshStatus?.nextRefreshAt === undefined
        ? {}
        : { nextRefreshAt: options.refreshStatus.nextRefreshAt }),
      ...(options.refreshStatus?.secondsUntilRefresh === undefined
        ? {}
        : {
          secondsUntilRefresh:
            options.refreshStatus.secondsUntilRefresh,
        }),
    })),
  };
}

function createFactory(
  builder: (
    channel: string,
    creationIndex: number,
  ) => ChannelSession | Promise<ChannelSession> = (channel) =>
    createSession(channel),
): ChannelSessionFactory & {
  readonly create: ReturnType<typeof vi.fn>;
} {
  let creationIndex = 0;

  return {
    create: vi.fn(
      async (channel: string): Promise<ChannelSession> => {
        const result = await builder(channel, creationIndex);
        creationIndex += 1;
        return result;
      },
    ),
  };
}

function createLogger(): SessionManagerLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function createGate(): {
  readonly promise: Promise<void>;
  readonly release: () => void;
} {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

function createRecoveryPolicy(now: () => number): ChannelRecoveryPolicy {
  return new ChannelRecoveryPolicy({
    recovery: createDefaultBrowserRecovery(),
    sessionStart: createDefaultBrowserSessionStart(),
    now,
  });
}

describe('DefaultSessionManager', () => {
  it('依輸入順序新增 session 並回報 active channels', async () => {
    const events: string[] = [];
    const sessions = new Map<string, TestSession>();
    const factory = createFactory((channel) => {
      const session = createSession(channel, {
        onStart: async () => {
          events.push(`start:${channel}`);
        },
      });
      sessions.set(channel, session);
      return session;
    });
    const manager = new DefaultSessionManager(factory);

    await manager.reconcile(['first', 'second']);

    expect(events).toEqual(['start:first', 'start:second']);
    expect(manager.getActiveChannels()).toEqual(['first', 'second']);
    expect(sessions.get('first')?.start).toHaveBeenCalledOnce();
    expect(sessions.get('second')?.start).toHaveBeenCalledOnce();
  });

  it('先依 registry 順序移除，再依 activeChannels 順序新增', async () => {
    const events: string[] = [];
    const factory = createFactory((channel) =>
      createSession(channel, {
        onStart: async () => {
          events.push(`start:${channel}`);
        },
        onStop: async (reason) => {
          events.push(`stop:${channel}:${reason}`);
        },
      }),
    );
    const manager = new DefaultSessionManager(factory);
    await manager.reconcile(['first', 'second']);
    events.length = 0;

    await manager.reconcile(['second', 'third']);

    expect(events).toEqual(['stop:first:inactive', 'start:third']);
    expect(manager.getActiveChannels()).toEqual(['second', 'third']);
  });

  it('保持既有 session、不重建，並依最新輸入順序回報', async () => {
    const factory = createFactory();
    const manager = new DefaultSessionManager(factory);
    await manager.reconcile(['first', 'second']);

    await manager.reconcile(['second', 'first', 'first']);

    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(manager.getActiveChannels()).toEqual(['second', 'first']);
  });

  it('可擷取預設或指定中的 active session 截圖', async () => {
    const manager = new DefaultSessionManager(createFactory());
    await manager.reconcile(['first', 'second']);

    await expect(manager.captureScreenshot()).resolves.toEqual({
      channel: 'first',
      image: Buffer.from('screenshot:first'),
    });
    await expect(manager.captureScreenshot('SECOND')).resolves.toEqual({
      channel: 'second',
      image: Buffer.from('screenshot:second'),
    });
    await expect(manager.captureScreenshot('missing')).resolves.toBeUndefined();
  });

  it('可取得全部或指定 active session 的忠誠點數', async () => {
    const manager = new DefaultSessionManager(createFactory((channel) =>
      createSession(channel, {
        channelPoints: channel === 'first'
          ? {
              status: 'available',
              balance: 3_500,
              displayValue: '3,500',
            }
          : { status: 'unavailable', reason: 'not_found' },
      })));
    await manager.reconcile(['first', 'second']);

    await expect(manager.getChannelPoints()).resolves.toEqual([
      {
        channel: 'first',
        status: 'available',
        balance: 3_500,
        displayValue: '3,500',
      },
      { channel: 'second', status: 'unavailable', reason: 'not_found' },
    ]);
    await expect(manager.getChannelPoints('FIRST')).resolves.toEqual([
      {
        channel: 'first',
        status: 'available',
        balance: 3_500,
        displayValue: '3,500',
      },
    ]);
    await expect(manager.getChannelPoints('missing')).resolves.toEqual([]);
  });

  it('依 active session 順序回報頁面重整狀態', async () => {
    const manager = new DefaultSessionManager(createFactory((channel) =>
      createSession(channel, {
        refreshStatus: {
          enabled: true,
          nextRefreshAt: `2026-06-14T12:0${channel === 'first' ? '1' : '2'}:00.000Z`,
          secondsUntilRefresh: channel === 'first' ? 60 : 120,
        },
      }),
    ));
    await manager.reconcile(['first', 'second']);

    expect(manager.getRefreshStatuses()).toEqual([
      {
        channel: 'first',
        enabled: true,
        nextRefreshAt: '2026-06-14T12:01:00.000Z',
        secondsUntilRefresh: 60,
      },
      {
        channel: 'second',
        enabled: true,
        nextRefreshAt: '2026-06-14T12:02:00.000Z',
        secondsUntilRefresh: 120,
      },
    ]);
  });

  it('可手動重整全部或指定 active session', async () => {
    const sessions = new Map<string, TestSession>();
    const manager = new DefaultSessionManager(createFactory((channel) => {
      const session = createSession(channel);
      sessions.set(channel, session);
      return session;
    }));
    await manager.reconcile(['first', 'second']);

    await expect(manager.refreshPages()).resolves.toEqual([
      { channel: 'first', status: 'refreshed' },
      { channel: 'second', status: 'refreshed' },
    ]);
    await expect(manager.refreshPages('SECOND')).resolves.toEqual([
      { channel: 'second', status: 'refreshed' },
    ]);
    await expect(manager.refreshPages('missing')).resolves.toEqual([]);
    expect(sessions.get('first')?.refreshNow).toHaveBeenCalledOnce();
    expect(sessions.get('second')?.refreshNow).toHaveBeenCalledTimes(2);
  });

  it('start failure 不留 registry，且不影響其他頻道啟動', async () => {
    const failed = createSession('failed', {
      onStart: async () => {
        throw new Error('start failed');
      },
    });
    const healthy = createSession('healthy');
    const factory = createFactory((channel) =>
      channel === 'failed' ? failed : healthy,
    );
    const logger = createLogger();
    const manager = new DefaultSessionManager(factory, { logger });

    await manager.reconcile(['failed', 'healthy']);

    expect(manager.getActiveChannels()).toEqual(['healthy']);
    expect(failed.stop).toHaveBeenCalledWith('start_failed');
    expect(healthy.start).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'session_start_failed',
      expect.objectContaining({ channel: 'failed' }),
    );
  });

  it('page crash 只對該頻道 backoff，其他 active session 保持運作', async () => {
    let nowMs = 0;
    const policy = createRecoveryPolicy(() => nowMs);
    const logger = createLogger();
    const factory = createFactory();
    const manager = new DefaultSessionManager(factory, {
      logger,
      recoveryPolicy: policy,
      configuredChannels: ['a', 'b', 'c'],
    });
    await manager.reconcile(['a', 'b', 'c']);

    await manager.invalidate('a', 'page_crashed');
    await manager.reconcile(['a', 'b', 'c']);

    expect(manager.getActiveChannels()).toEqual(['b', 'c']);
    expect(factory.create).toHaveBeenCalledTimes(3);
    expect(logger.debug).toHaveBeenCalledWith(
      'channel_recovery_deferred',
      expect.objectContaining({ channel: 'a', retryAtMs: 30_000 }),
    );

    nowMs = 30_000;
    await manager.reconcile(['a', 'b', 'c']);
    expect(manager.getActiveChannels()).toEqual(['a', 'b', 'c']);
    expect(logger.debug).toHaveBeenCalledWith(
      'channel_recovery_probe_started',
      expect.objectContaining({ channel: 'a', recoveryGeneration: 1 }),
    );

    nowMs += 1_800_000;
    await manager.reconcile(['a', 'b', 'c']);
    expect(policy.getState('a').consecutivePageCrashes).toBe(0);
    expect(logger.debug).toHaveBeenCalledWith(
      'channel_recovery_reset',
      { channel: 'a', recoveryGeneration: 1 },
    );
  });

  it('健康失敗逐步冷卻，重複失效不重算，其他頻道不受影響且穩定後重設', async () => {
    let nowMs = 0;
    const policy = createRecoveryPolicy(() => nowMs);
    const factory = createFactory();
    const logger = createLogger();
    const manager = new DefaultSessionManager(factory, {
      logger,
      recoveryPolicy: policy,
      configuredChannels: ['a', 'b'],
    });
    await manager.reconcile(['a', 'b']);

    for (const cooldownMs of [30_000, 60_000, 120_000, 900_000]) {
      await manager.invalidate('a', 'health_failure_threshold');
      const retryAtMs = nowMs + cooldownMs;
      expect(policy.getState('a').nextRetryAtMs).toBe(retryAtMs);
      expect(policy.getState('a').consecutivePageCrashes).toBe(0);
      await manager.invalidate('a', 'health_failure_threshold');
      expect(policy.getState('a').nextRetryAtMs).toBe(retryAtMs);
      const creations = factory.create.mock.calls.length;
      nowMs = retryAtMs - 1;
      await manager.reconcile(['a', 'b']);
      expect(manager.getActiveChannels()).toEqual(['b']);
      expect(factory.create).toHaveBeenCalledTimes(creations);
      nowMs = retryAtMs;
      await manager.reconcile(['a', 'b']);
      expect(manager.getActiveChannels()).toEqual(['a', 'b']);
    }
    expect(logger.warn).toHaveBeenCalledWith(
      'channel_health_recovery_backoff',
      expect.objectContaining({ channel: 'a', consecutiveFailures: 4 }),
    );
    nowMs += 1_800_000;
    await manager.reconcile(['a', 'b']);
    expect(policy.getState('a').consecutiveStartFailures).toBe(0);
    await manager.invalidate('a', 'health_failure_threshold');
    expect(policy.getState('a').nextRetryAtMs).toBe(nowMs + 30_000);
    await manager.stopAll('test_complete');
  });

  it('quarantine 到期前不啟動，到期後只啟動一個 probe', async () => {
    let nowMs = 0;
    const policy = createRecoveryPolicy(() => nowMs);
    for (const crashAtMs of [0, 30_000, 90_000, 210_000]) {
      nowMs = crashAtMs;
      policy.recordPageCrash('channel');
    }
    const logger = createLogger();
    const factory = createFactory();
    const manager = new DefaultSessionManager(factory, {
      logger,
      recoveryPolicy: policy,
      configuredChannels: ['channel'],
    });

    await manager.reconcile(['channel']);
    expect(factory.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'channel_recovery_quarantined',
      expect.objectContaining({ channel: 'channel' }),
    );

    nowMs = 1_110_000;
    await Promise.all([
      manager.reconcile(['channel']),
      manager.reconcile(['channel']),
    ]);
    expect(factory.create).toHaveBeenCalledOnce();
    expect(manager.getActiveChannels()).toEqual(['channel']);
  });

  it('recoverable start failure 進入 cooldown，fatal prerequisite 不計入', async () => {
    const recoverablePolicy = createRecoveryPolicy(() => 0);
    const recoverableFactory = createFactory(() =>
      createSession('recoverable', {
        onStart: async () => {
          throw new Error('Target page, context or browser has been closed');
        },
      }));
    const recoverable = new DefaultSessionManager(recoverableFactory, {
      recoveryPolicy: recoverablePolicy,
      configuredChannels: ['recoverable'],
    });
    await recoverable.reconcile(['recoverable']);
    await recoverable.reconcile(['recoverable']);
    expect(recoverableFactory.create).toHaveBeenCalledOnce();
    expect(
      recoverablePolicy.getState('recoverable').consecutiveStartFailures,
    ).toBe(1);

    const fatalPolicy = createRecoveryPolicy(() => 0);
    const fatalFactory = createFactory(() =>
      createSession('fatal', {
        onStart: async () => {
          throw new Error('authentication failed');
        },
      }));
    const fatal = new DefaultSessionManager(fatalFactory, {
      recoveryPolicy: fatalPolicy,
      configuredChannels: ['fatal'],
    });
    await fatal.reconcile(['fatal']);
    await fatal.reconcile(['fatal']);
    expect(fatalFactory.create).toHaveBeenCalledTimes(2);
    expect(fatalPolicy.getState('fatal').consecutiveStartFailures).toBe(0);
  });

  it('只有從 configured channels 移除時才清除 recovery state', async () => {
    const policy = createRecoveryPolicy(() => 0);
    policy.recordPageCrash('removed');
    const manager = new DefaultSessionManager(createFactory(), {
      recoveryPolicy: policy,
      configuredChannels: ['removed', 'kept'],
    });

    await manager.reconcile([]);
    expect(policy.getState('removed').consecutivePageCrashes).toBe(1);
    manager.updateConfiguredChannels(['kept']);
    expect(policy.getState('removed').consecutivePageCrashes).toBe(0);
  });

  it('session start 卡住時會 timeout 並繼續啟動後續頻道', async () => {
    vi.useFakeTimers();
    try {
      const startGate = createGate();
      const lifecycleEvents: string[] = [];
      const stuck = createSession('stuck', {
        onStart: async () => {
          await startGate.promise;
          lifecycleEvents.push('late_start_completed');
        },
        onCancelStart: async (reason) => {
          lifecycleEvents.push(`cancel:${reason}`);
          startGate.release();
        },
        onStop: async (reason) => {
          lifecycleEvents.push(`stop:${reason}`);
        },
      });
      const healthy = createSession('healthy');
      const factory = createFactory((channel) =>
        channel === 'stuck' ? stuck : healthy,
      );
      const logger = createLogger();
      const manager = new DefaultSessionManager(factory, {
        logger,
        sessionOperationTimeoutMs: 1_000,
      });

      const reconcile = manager.reconcile(['stuck', 'healthy']);
      await vi.waitFor(() => {
        expect(stuck.start).toHaveBeenCalledOnce();
      });
      expect(healthy.start).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await reconcile;

      expect(manager.getActiveChannels()).toEqual(['healthy']);
      expect(healthy.start).toHaveBeenCalledOnce();
      expect(stuck.cancelStart).toHaveBeenCalledWith('start_timeout');
      expect(stuck.stop).toHaveBeenCalledWith('start_failed');
      expect(lifecycleEvents).toEqual([
        'cancel:start_timeout',
        'late_start_completed',
        'stop:start_failed',
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        'session_start_timeout',
        {
          channel: 'stuck',
          attempt: 1,
          timeoutMs: 1_000,
        },
      );
      expect(logger.error).toHaveBeenCalledWith(
        'session_start_failed',
        expect.objectContaining({ channel: 'stuck' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('啟動失敗為瀏覽器關閉時會清理舊 session 並短重試', async () => {
    const failed = createSession('channel', {
      onStart: async () => {
        throw new Error(
          'page.goto: Target page, context or browser has been closed',
        );
      },
    });
    const healthy = createSession('channel');
    const factory = createFactory((_channel, creationIndex) =>
      creationIndex === 0 ? failed : healthy,
    );
    const logger = createLogger();
    const sleeps: number[] = [];
    const manager = new DefaultSessionManager(factory, {
      logger,
      startRetryAttempts: 1,
      startRetryDelayMs: 2_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await manager.reconcile(['channel']);

    expect(manager.getActiveChannels()).toEqual(['channel']);
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(failed.stop).toHaveBeenCalledWith('start_failed');
    expect(healthy.start).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([2_000]);
    expect(logger.warn).toHaveBeenCalledWith(
      'session_start_retry_scheduled',
      expect.objectContaining({
        channel: 'channel',
        attempt: 1,
        retryInMs: 2_000,
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('啟動失敗為 Twitch 導覽逾時時會清理舊 session 並短重試', async () => {
    const failed = createSession('channel', {
      onStart: async () => {
        throw new Error(
          'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://www.twitch.tv/channel", waiting until "load"',
        );
      },
    });
    const healthy = createSession('channel');
    const factory = createFactory((_channel, creationIndex) =>
      creationIndex === 0 ? failed : healthy,
    );
    const logger = createLogger();
    const sleeps: number[] = [];
    const navigationOutcomes: unknown[] = [];
    const manager = new DefaultSessionManager(factory, {
      logger,
      startRetryAttempts: 1,
      startRetryDelayMs: 2_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      onNavigationOutcomes: async (outcomes) => {
        navigationOutcomes.push(...outcomes);
      },
    });

    await manager.reconcile(['channel']);

    expect(manager.getActiveChannels()).toEqual(['channel']);
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(failed.stop).toHaveBeenCalledWith('start_failed');
    expect(healthy.start).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([2_000]);
    expect(navigationOutcomes).toEqual([
      { channel: 'channel', status: 'succeeded' },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'session_start_retry_scheduled',
      expect.objectContaining({
        channel: 'channel',
        attempt: 1,
        retryInMs: 2_000,
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('導覽短重試仍逾時時只在最終失敗後回報一次', async () => {
    const events: string[] = [];
    const timeoutError =
      'page.goto: Timeout 30000ms exceeded.\nCall log:\n' +
      '  - navigating to "https://www.twitch.tv/channel", waiting until "domcontentloaded"';
    const factory = createFactory((_channel, creationIndex) =>
      createSession('channel', {
        onStart: async () => {
          throw new Error(timeoutError);
        },
        onStop: async () => {
          events.push(`stop:${creationIndex}`);
        },
      }));
    const navigationOutcomes: unknown[] = [];
    const manager = new DefaultSessionManager(factory, {
      startRetryAttempts: 1,
      startRetryDelayMs: 0,
      onNavigationOutcomes: async (outcomes) => {
        events.push('observer');
        navigationOutcomes.push(...outcomes);
      },
    });

    await manager.reconcile(['channel']);

    expect(manager.getActiveChannels()).toEqual([]);
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['stop:0', 'stop:1', 'observer']);
    expect(navigationOutcomes).toEqual([
      { channel: 'channel', status: 'timed_out' },
    ]);
  });

  it('非導覽逾時的啟動失敗不回報 navigation outcome', async () => {
    const onNavigationOutcomes = vi.fn();
    const manager = new DefaultSessionManager(
      createFactory(() =>
        createSession('channel', {
          onStart: async () => {
            throw new Error('authentication failed');
          },
        })),
      { onNavigationOutcomes },
    );

    await manager.reconcile(['channel']);

    expect(manager.getActiveChannels()).toEqual([]);
    expect(onNavigationOutcomes).not.toHaveBeenCalled();
  });

  it('navigation outcome observer 可在 reconcile 鎖外失效 session', async () => {
    const session = createSession('channel');
    const manager = new DefaultSessionManager(createFactory(() => session), {
      onNavigationOutcomes: async () => {
        await manager.invalidate('channel', 'browser_restarted');
      },
    });

    await manager.reconcile(['channel']);

    expect(manager.getActiveChannels()).toEqual([]);
    expect(session.stop).toHaveBeenCalledWith('browser_restarted');
  });

  it('新增多個 session 時會在後續啟動前套用間隔', async () => {
    const events: string[] = [];
    const factory = createFactory((channel) =>
      createSession(channel, {
        onStart: async () => {
          events.push(`start:${channel}`);
        },
      }),
    );
    const manager = new DefaultSessionManager(factory, {
      startStaggerMs: 1_000,
      sleep: async (milliseconds) => {
        events.push(`sleep:${milliseconds}`);
      },
    });

    await manager.reconcile(['first', 'second', 'third']);

    expect(events).toEqual([
      'start:first',
      'sleep:1000',
      'start:second',
      'sleep:1000',
      'start:third',
    ]);
    expect(manager.getActiveChannels()).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('factory failure 不影響後續頻道，下一輪可重試', async () => {
    let failedOnce = false;
    const factory = createFactory((channel) => {
      if (channel === 'first' && !failedOnce) {
        failedOnce = true;
        throw new Error('factory failed');
      }

      return createSession(channel);
    });
    const manager = new DefaultSessionManager(factory);

    await manager.reconcile(['first', 'second']);
    expect(manager.getActiveChannels()).toEqual(['second']);

    await manager.reconcile(['first', 'second']);
    expect(manager.getActiveChannels()).toEqual(['first', 'second']);
    expect(factory.create).toHaveBeenCalledTimes(3);
  });

  it('stop failure 仍移除舊 session 並繼續新增', async () => {
    const failedStop = createSession('first', {
      onStop: async () => {
        throw new Error('stop failed');
      },
    });
    const healthy = createSession('second');
    const factory = createFactory((channel) =>
      channel === 'first' ? failedStop : healthy,
    );
    const logger = createLogger();
    const manager = new DefaultSessionManager(factory, { logger });
    await manager.reconcile(['first']);

    await manager.reconcile(['second']);

    expect(manager.getActiveChannels()).toEqual(['second']);
    expect(healthy.start).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'session_stop_failed',
      expect.objectContaining({
        channel: 'first',
        reason: 'inactive',
      }),
    );
  });

  it('截圖失敗時回傳 undefined 並記錄可診斷錯誤', async () => {
    const logger = createLogger();
    const stale = createSession('stale');
    vi.mocked(stale.captureScreenshot).mockRejectedValue(
      new Error('Target page has been closed'),
    );
    const healthy = createSession('healthy');
    const manager = new DefaultSessionManager(
      createFactory((channel) => (channel === 'stale' ? stale : healthy)),
      { logger },
    );
    await manager.reconcile(['stale', 'healthy']);

    await expect(manager.captureScreenshot()).resolves.toEqual({
      channel: 'healthy',
      image: Buffer.from('screenshot:healthy'),
    });
    await expect(manager.captureScreenshot('stale')).resolves.toBeUndefined();
    await expect(manager.captureScreenshot('healthy')).resolves.toEqual({
      channel: 'healthy',
      image: Buffer.from('screenshot:healthy'),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'session_screenshot_failed',
      {
        channel: 'stale',
        error: 'Target page has been closed',
      },
    );
  });

  it('stopAll 隔離 stop failure、清空 registry 且可重複呼叫', async () => {
    const first = createSession('first', {
      onStop: async () => {
        throw new Error('stop failed');
      },
    });
    const second = createSession('second');
    const factory = createFactory((channel) =>
      channel === 'first' ? first : second,
    );
    const manager = new DefaultSessionManager(factory);
    await manager.reconcile(['first', 'second']);

    await Promise.all([
      manager.stopAll('shutdown'),
      manager.stopAll('duplicate_shutdown'),
    ]);

    expect(manager.getActiveChannels()).toEqual([]);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(first.stop).toHaveBeenCalledWith('shutdown');
    expect(second.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledWith('shutdown');
  });

  it('invalidate 移除並停止 session，重複呼叫無副作用且可由 reconcile 重建', async () => {
    const created: TestSession[] = [];
    const factory = createFactory((channel) => {
      const session = createSession(channel);
      created.push(session);
      return session;
    });
    const manager = new DefaultSessionManager(factory);
    await manager.reconcile(['channel']);

    await manager.invalidate('channel', 'page_crashed');
    await manager.invalidate('channel', 'duplicate_crash');

    expect(manager.getActiveChannels()).toEqual([]);
    expect(created[0]?.stop).toHaveBeenCalledOnce();
    expect(created[0]?.stop).toHaveBeenCalledWith('page_crashed');

    await manager.reconcile(['channel']);

    expect(manager.getActiveChannels()).toEqual(['channel']);
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(created[1]?.start).toHaveBeenCalledOnce();
  });

  it('stop failure 時 invalidate 仍移除，下一輪可重建', async () => {
    const factory = createFactory((channel, creationIndex) =>
      createSession(channel, {
        onStop:
          creationIndex === 0
            ? async () => {
                throw new Error('stop failed');
              }
            : undefined,
      }),
    );
    const manager = new DefaultSessionManager(factory);
    await manager.reconcile(['channel']);

    await manager.invalidate('channel', 'browser_disconnected');
    await manager.reconcile(['channel']);

    expect(manager.getActiveChannels()).toEqual(['channel']);
    expect(factory.create).toHaveBeenCalledTimes(2);
  });

  it('併發 reconcile 依呼叫順序序列化且不重複建立同頻道', async () => {
    const startEntered = createGate();
    const allowStart = createGate();
    const factory = createFactory((channel) =>
      createSession(channel, {
        onStart:
          channel === 'first'
            ? async () => {
                startEntered.release();
                await allowStart.promise;
              }
            : undefined,
      }),
    );
    const manager = new DefaultSessionManager(factory);

    const firstReconcile = manager.reconcile(['first']);
    await startEntered.promise;
    const secondReconcile = manager.reconcile(['first', 'second']);

    expect(factory.create).toHaveBeenCalledTimes(1);
    allowStart.release();
    await Promise.all([firstReconcile, secondReconcile]);

    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(factory.create).toHaveBeenNthCalledWith(1, 'first');
    expect(factory.create).toHaveBeenNthCalledWith(2, 'second');
    expect(manager.getActiveChannels()).toEqual(['first', 'second']);
  });

  it('stopAll 會等待先提交的 reconcile 完成後再清空', async () => {
    const startEntered = createGate();
    const allowStart = createGate();
    const session = createSession('channel', {
      onStart: async () => {
        startEntered.release();
        await allowStart.promise;
      },
    });
    const manager = new DefaultSessionManager(
      createFactory(() => session),
    );

    const reconcile = manager.reconcile(['channel']);
    await startEntered.promise;
    const stopAll = manager.stopAll('shutdown');
    allowStart.release();
    await Promise.all([reconcile, stopAll]);

    expect(session.stop).toHaveBeenCalledWith('shutdown');
    expect(manager.getActiveChannels()).toEqual([]);
  });

  it('invalidate 會等待先提交的 reconcile 完成後移除該 session', async () => {
    const startEntered = createGate();
    const allowStart = createGate();
    const session = createSession('channel', {
      onStart: async () => {
        startEntered.release();
        await allowStart.promise;
      },
    });
    const manager = new DefaultSessionManager(
      createFactory(() => session),
    );

    const reconcile = manager.reconcile(['channel']);
    await startEntered.promise;
    const invalidate = manager.invalidate('channel', 'page_crashed');
    allowStart.release();
    await Promise.all([reconcile, invalidate]);

    expect(session.stop).toHaveBeenCalledWith('page_crashed');
    expect(manager.getActiveChannels()).toEqual([]);
  });

  it('單一頻道 start 卡住不會阻塞其他頻道 invalidate', async () => {
    const startEntered = createGate();
    const allowStart = createGate();
    const sessions = new Map<string, TestSession>();
    const manager = new DefaultSessionManager(createFactory((channel) => {
      const session = createSession(channel, {
        onStart:
          channel === 'stuck'
            ? async () => {
                startEntered.release();
                await allowStart.promise;
              }
            : undefined,
      });
      sessions.set(channel, session);
      return session;
    }));
    await manager.reconcile(['active']);

    const reconcile = manager.reconcile(['active', 'stuck']);
    await startEntered.promise;
    await manager.invalidate('active', 'page_crashed');

    expect(sessions.get('active')?.stop).toHaveBeenCalledWith('page_crashed');
    expect(manager.getActiveChannels()).toEqual([]);

    allowStart.release();
    await reconcile;
  });

  it('stopAll 會取消進行中的 start 後在有限時間內完成', async () => {
    const startEntered = createGate();
    const startGate = createGate();
    const session = createSession('channel', {
      onStart: async () => {
        startEntered.release();
        await startGate.promise;
      },
      onCancelStart: async () => {
        startGate.release();
      },
    });
    const manager = new DefaultSessionManager(
      createFactory(() => session),
      { sessionOperationTimeoutMs: 1_000 },
    );

    const reconcile = manager.reconcile(['channel']);
    await startEntered.promise;
    await manager.stopAll('shutdown');
    await reconcile;

    expect(session.cancelStart).toHaveBeenCalledWith('shutdown');
    expect(session.stop).toHaveBeenCalled();
    expect(manager.getActiveChannels()).toEqual([]);
  });

  it('cancelStart 未解除卡住操作時 stopAll 仍會 timeout 完成', async () => {
    vi.useFakeTimers();
    try {
      const startEntered = createGate();
      const never = createGate();
      const session = createSession('channel', {
        onStart: async () => {
          startEntered.release();
          await never.promise;
        },
      });
      const manager = new DefaultSessionManager(
        createFactory(() => session),
        { sessionOperationTimeoutMs: 1_000 },
      );

      const reconcile = manager.reconcile(['channel']);
      await startEntered.promise;
      const stopAll = manager.stopAll('shutdown');

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(stopAll).resolves.toBeUndefined();
      await reconcile;

      expect(session.cancelStart).toHaveBeenCalledWith('shutdown');
      expect(manager.getActiveChannels()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('輸入只對完全相同字串去重，大小寫不同視為不同頻道', async () => {
    const factory = createFactory();
    const manager = new DefaultSessionManager(factory);

    await manager.reconcile([
      'Channel',
      'Channel',
      'channel',
      'CHANNEL',
      'channel',
    ]);

    expect(manager.getActiveChannels()).toEqual([
      'Channel',
      'channel',
      'CHANNEL',
    ]);
    expect(factory.create).toHaveBeenCalledTimes(3);
  });

  it('失敗日誌遮罩敏感錯誤內容且不傳 session object', async () => {
    const logger = createLogger();
    const session = createSession('channel', {
      onStart: async () => {
        throw new Error('access_token=top-secret-value');
      },
    });
    const manager = new DefaultSessionManager(
      createFactory(() => session),
      { logger },
    );

    await manager.reconcile(['channel']);

    const errorCall = vi.mocked(logger.error).mock.calls[0];
    expect(errorCall).toBeDefined();
    expect(JSON.stringify(errorCall)).not.toContain('top-secret-value');
    expect(errorCall?.[1]).not.toHaveProperty('session');
    expect(errorCall?.[1]).toEqual({
      channel: 'channel',
      error: 'access_token=[REDACTED]',
    });
  });
});
