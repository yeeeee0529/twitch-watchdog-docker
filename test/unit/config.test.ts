import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  YamlConfigLoader,
  type AppConfig,
  type ConfigLogger,
} from '../../src/config/index.js';

const fixtureDirectory = fileURLToPath(
  new URL('../fixtures/config/', import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('YamlConfigLoader', () => {
  it('載入合法 YAML 並將 snake_case 轉為 camelCase', async () => {
    const config = await loadFixture('valid.yml');

    expect(config).toEqual({
      channels: ['streamer_one', 'streamer_two', 'streamer_three'],
      checkIntervalSeconds: 90,
      maxConcurrentStreams: 2,
      headless: false,
      storageStatePath: '/tmp/test-storage-state.json',
      logLevel: 'debug',
      twitchApi: {
        clientId: 'fixture-client-id',
        accessToken: 'fixture-access-token',
        clientSecret: '',
      },
      browser: {
        engine: 'chromium',
        navigationTimeoutMs: 45_000,
        pageHealthCheckIntervalSeconds: 40,
        rewardCheckIntervalSeconds: 20,
        pageRefreshIntervalSeconds: 900,
        restartOnCrash: false,
        streamQuality: '360p',
        enforceStreamQualitySeconds: 180,
        viewportWidth: 800,
        viewportHeight: 450,
        muteAudio: false,
        blockImages: false,
        blockFonts: false,
        blockKnownTracking: true,
        disableChat: false,
        resourceTelemetryIntervalSeconds: 240,
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
        },
        sessionStart: {
          failureBackoffSeconds: [30, 60, 120],
          maximumCooldownSeconds: 900,
        },
        resourceGuard: {
          enabled: true,
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
            maxConcurrentStreams: 2,
            warningMemoryMib: 2_901,
            warningResetMemoryMib: 2_731,
            browserRecycleMemoryMib: 3_243,
            emergencyMemoryMib: 3_755,
            postRecycleTargetMemoryMib: 2_901,
          },
        },
      },
      telegram: {
        enabled: false,
        botToken: '',
        allowedChatIds: [],
        pollingTimeoutSeconds: 25,
      },
      discord: {
        enabled: false,
        botToken: '',
        applicationId: '',
        guildId: '',
        allowedChannelIds: [],
        allowDirectMessages: false,
        allowedUserIds: [],
      },
    });
  });

  it('config.example.yml 是可直接複製使用的單檔設定範例', async () => {
    const config = await new YamlConfigLoader().load(
      fileURLToPath(new URL('../../config.example.yml', import.meta.url)),
      {},
    );

    expect(config.twitchApi.clientId).toBe('your_twitch_client_id');
    expect(config.twitchApi.clientSecret).toBe(
      'your_twitch_client_secret',
    );
    expect(config.browser.pageRefreshIntervalSeconds).toBe(0);
    expect(config.browser.engine).toBe('chromium');
    expect(config.browser.resourceTelemetryIntervalSeconds).toBe(60);
    expect(config.browser.recovery.pageCrashBackoffSeconds).toEqual([
      30,
      60,
      120,
    ]);
    expect(config.browser.sessionStart.maximumCooldownSeconds).toBe(900);
    expect(config.browser.resourceGuard.enabled).toBe(true);
    expect(config.browser.resourceGuard.effective.maxConcurrentStreams).toBe(
      2,
    );
    expect(config.telegram.enabled).toBe(false);
    expect(config.discord.enabled).toBe(false);
  });

  it('載入自訂的頻道復原與 session 啟動冷卻設定', async () => {
    const config = await loadSource(`channels: [streamer]
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
browser:
  recovery:
    page_crash_backoff_seconds: [10, 20, 40]
    channel_crash_window_seconds: 300
    channel_quarantine_threshold: 5
    channel_quarantine_seconds: 1200
    stable_reset_seconds: 2400
    multi_channel_crash_window_seconds: 20
    multi_channel_crash_threshold: 3
    browser_failure_window_seconds: 900
    browser_failure_container_threshold: 4
  session_start:
    failure_backoff_seconds: [15, 45]
    maximum_cooldown_seconds: 600
`);

    expect(config.browser.recovery).toEqual({
      pageCrashBackoffSeconds: [10, 20, 40],
      channelCrashWindowSeconds: 300,
      channelQuarantineThreshold: 5,
      channelQuarantineSeconds: 1_200,
      stableResetSeconds: 2_400,
      multiChannelCrashWindowSeconds: 20,
      multiChannelCrashThreshold: 3,
      browserFailureWindowSeconds: 900,
      browserFailureContainerThreshold: 4,
    });
    expect(config.browser.sessionStart).toEqual({
      failureBackoffSeconds: [15, 45],
      maximumCooldownSeconds: 600,
    });
  });

  it.each([
    [
      'recovery 不是物件',
      'browser:\n  recovery: invalid',
    ],
    [
      'page crash backoff 為空',
      'browser:\n  recovery:\n    page_crash_backoff_seconds: []',
    ],
    [
      'page crash backoff 含非正整數',
      'browser:\n  recovery:\n    page_crash_backoff_seconds: [30, 0]',
    ],
    [
      'quarantine 小於十分鐘',
      'browser:\n  recovery:\n    channel_quarantine_seconds: 599',
    ],
    [
      'quarantine 大於三十分鐘',
      'browser:\n  recovery:\n    channel_quarantine_seconds: 1801',
    ],
    [
      'session_start 不是物件',
      'browser:\n  session_start: invalid',
    ],
    [
      'session start backoff 為空',
      'browser:\n  session_start:\n    failure_backoff_seconds: []',
    ],
    [
      'session start cooldown 不是正整數',
      'browser:\n  session_start:\n    maximum_cooldown_seconds: 0',
    ],
  ])('%s 時拒絕設定', async (_name, browserSource) => {
    await expect(
      loadSource(`${browserSource}
channels: [streamer]
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
`),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('resource_guard 門檻依 max_concurrent_streams 縮放（N=3 錨點）', async () => {
    const config = await loadSource(
      `${configWithChannels([
        'one',
        'two',
        'three',
        'four',
        'five',
      ])}max_concurrent_streams: 5\n`,
    );

    expect(config.browser.resourceGuard.effective).toEqual({
      maxConcurrentStreams: 5,
      warningMemoryMib: 6_485,
      warningResetMemoryMib: 6_059,
      browserRecycleMemoryMib: 7_339,
      emergencyMemoryMib: 8_619,
      postRecycleTargetMemoryMib: 6_485,
    });
  });

  it('resource_guard.scale_with_streams 為 false 時使用絕對門檻', async () => {
    const config = await loadSource(`channels: [streamer]
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
browser:
  resource_guard:
    scale_with_streams: false
    warning_memory_mib: 5000
    warning_reset_memory_mib: 4500
    browser_recycle_memory_mib: 5500
    emergency_memory_mib: 6000
    post_recycle_target_memory_mib: 4800
`);

    expect(config.browser.resourceGuard.effective.warningMemoryMib).toBe(5_000);
    expect(config.browser.resourceGuard.effective.emergencyMemoryMib).toBe(
      6_000,
    );
  });

  it('resource_guard 門檻順序錯誤時拒絕設定', async () => {
    await expect(
      loadSource(`channels: [streamer]
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
browser:
  resource_guard:
    warning_memory_mib: 5000
    browser_recycle_memory_mib: 4000
    emergency_memory_mib: 6000
`),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('支援正式 YAML 的引號、註解與 flow sequence', async () => {
    const config = await loadSource(`
# flow sequence 與引號內的特殊字元應由正式 YAML parser 處理
channels: ["quoted_channel", 'second_channel'] # 行尾註解
storage_state_path: "/tmp/state # 1.json"
twitch_api:
  client_id: 'client: # not a comment'
  access_token: "fixture-token"
`);

    expect(config.channels).toEqual(['quoted_channel', 'second_channel']);
    expect(config.storageStatePath).toBe('/tmp/state # 1.json');
    expect(config.twitchApi.clientId).toBe('client: # not a comment');
  });

  it('套用所有預設值並將併發數降為頻道數', async () => {
    const debug = vi.fn<ConfigLogger['debug']>();
    const config = await loadFixture('defaults.yml', {}, { debug });

    expect(config).toEqual({
      channels: ['streamer_one', 'streamer_two'],
      checkIntervalSeconds: 60,
      maxConcurrentStreams: 2,
      headless: true,
      storageStatePath: '/data/browser-state/storage-state.json',
      logLevel: 'info',
      twitchApi: {
        clientId: 'fixture-client-id',
        accessToken: 'fixture-access-token',
        clientSecret: '',
      },
      browser: {
        engine: 'chromium',
        navigationTimeoutMs: 30_000,
        pageHealthCheckIntervalSeconds: 60,
        rewardCheckIntervalSeconds: 30,
        pageRefreshIntervalSeconds: 0,
        restartOnCrash: true,
        streamQuality: '160p',
        enforceStreamQualitySeconds: 120,
        viewportWidth: 1280,
        viewportHeight: 720,
        muteAudio: true,
        blockImages: false,
        blockFonts: false,
        blockKnownTracking: false,
        disableChat: true,
        resourceTelemetryIntervalSeconds: 60,
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
        },
        sessionStart: {
          failureBackoffSeconds: [30, 60, 120],
          maximumCooldownSeconds: 900,
        },
        resourceGuard: {
          enabled: true,
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
            maxConcurrentStreams: 2,
            warningMemoryMib: 2_901,
            warningResetMemoryMib: 2_731,
            browserRecycleMemoryMib: 3_243,
            emergencyMemoryMib: 3_755,
            postRecycleTargetMemoryMib: 2_901,
          },
        },
      },
      telegram: {
        enabled: false,
        botToken: '',
        allowedChatIds: [],
        pollingTimeoutSeconds: 25,
      },
      discord: {
        enabled: false,
        botToken: '',
        applicationId: '',
        guildId: '',
        allowedChannelIds: [],
        allowDirectMessages: false,
        allowedUserIds: [],
      },
    });
    expect(debug).toHaveBeenCalledWith('config_concurrency_clamped', {
      requestedMaxConcurrentStreams: 3,
      effectiveMaxConcurrentStreams: 2,
      channelCount: 2,
    });
  });

  it('頻道數足夠時 max_concurrent_streams 預設為 3', async () => {
    const debug = vi.fn<ConfigLogger['debug']>();
    const config = await loadSource(
      configWithChannels([
        'streamer_one',
        'streamer_two',
        'streamer_three',
        'streamer_four',
      ]),
      {},
      { debug },
    );

    expect(config.maxConcurrentStreams).toBe(3);
    expect(debug).not.toHaveBeenCalled();
  });

  it('未指定 browser.engine 時預設為 chromium', async () => {
    const config = await loadSource(
      'channels: [streamer]\n'
      + 'twitch_api:\n'
      + '  client_id: fixture-client-id\n'
      + '  access_token: fixture-access-token\n',
    );

    expect(config.browser.engine).toBe('chromium');
  });

  it('明確指定 firefox 仍受支援', async () => {
    const config = await loadSource(
      'channels: [streamer]\n'
      + 'twitch_api:\n'
      + '  client_id: fixture-client-id\n'
      + '  access_token: fixture-access-token\n'
      + 'browser:\n'
      + '  engine: firefox\n',
    );

    expect(config.browser.engine).toBe('firefox');
  });

  it('明確指定 chromium 仍受支援', async () => {
    const config = await loadSource(
      'channels: [streamer]\n'
      + 'twitch_api:\n'
      + '  client_id: fixture-client-id\n'
      + '  access_token: fixture-access-token\n'
      + 'browser:\n'
      + '  engine: chromium\n',
    );

    expect(config.browser.engine).toBe('chromium');
  });

  it('顯式併發數大於頻道數時降級並輸出 debug 事件', async () => {
    const debug = vi.fn<ConfigLogger['debug']>();
    const config = await loadSource(
      `${configWithChannels(['one', 'two'])}max_concurrent_streams: 8\n`,
      {},
      { debug },
    );

    expect(config.maxConcurrentStreams).toBe(2);
    expect(debug).toHaveBeenCalledWith('config_concurrency_clamped', {
      requestedMaxConcurrentStreams: 8,
      effectiveMaxConcurrentStreams: 2,
      channelCount: 2,
    });
  });

  it('替換 ${ENV_VAR} 且讓直接環境覆寫優先', async () => {
    const configPath = fixturePath('env.yml');
    const config = await new YamlConfigLoader().load('/missing/config.yml', {
      CONFIG_PATH: configPath,
      PRIMARY_CHANNEL: 'environment_channel',
      FILE_CLIENT_ID: 'file-client-id',
      FILE_ACCESS_TOKEN: 'file-access-token',
      TWITCH_CLIENT_ID: 'override-client-id',
      TWITCH_ACCESS_TOKEN: 'override-access-token',
      LOG_LEVEL: 'warn',
      HEADLESS: 'FALSE',
    });

    expect(config.channels).toEqual([
      'environment_channel',
      'static_channel',
    ]);
    expect(config.twitchApi).toEqual({
      clientId: 'override-client-id',
      accessToken: 'override-access-token',
      clientSecret: '',
    });
    expect(config.logLevel).toBe('warn');
    expect(config.headless).toBe(false);
  });

  it('缺少的環境替換值會成為空字串並由欄位驗證拒絕', async () => {
    await expect(
      loadFixture('env.yml', {
        PRIMARY_CHANNEL: 'environment_channel',
        FILE_CLIENT_ID: 'file-client-id',
      }),
    ).rejects.toMatchObject({
      name: 'ConfigValidationError',
      field: 'twitch_api',
    });
  });

  it('只有 Client ID 與 Client Secret 時允許啟動設定', async () => {
    const config = await loadSource(`
channels: [streamer]
twitch_api:
  client_id: fixture-client-id
  client_secret: fixture-client-secret
`);

    expect(config.twitchApi).toEqual({
      clientId: 'fixture-client-id',
      accessToken: '',
      clientSecret: 'fixture-client-secret',
    });
  });

  it('拒絕不是 true 或 false 的 HEADLESS', async () => {
    await expect(
      loadFixture('valid.yml', { HEADLESS: 'yes' }),
    ).rejects.toThrow(/headless.*true.*false/u);
  });

  it('可由環境變數啟用 Telegram 並解析多個 chat ID', async () => {
    const config = await loadFixture('defaults.yml', {
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: '123456:test-token',
      TELEGRAM_ALLOWED_CHAT_IDS: '42, -100123,42',
    });

    expect(config.telegram).toEqual({
      enabled: true,
      botToken: '123456:test-token',
      allowedChatIds: ['42', '-100123'],
      pollingTimeoutSeconds: 25,
    });
  });

  it.each([
    ['缺少 bot token', { TELEGRAM_ENABLED: 'true', TELEGRAM_ALLOWED_CHAT_IDS: '42' }],
    ['缺少 chat ID', { TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'token' }],
    ['chat ID 格式錯誤', {
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_ALLOWED_CHAT_IDS: 'not-a-chat',
    }],
  ])('Telegram %s 時拒絕設定', async (_name, env) => {
    await expect(loadFixture('defaults.yml', env)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('可由環境變數啟用 Discord 並解析多個 channel ID', async () => {
    const config = await loadFixture('defaults.yml', {
      DISCORD_ENABLED: 'true',
      DISCORD_BOT_TOKEN: 'discord-token',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_GUILD_ID: '987654321098765432',
      DISCORD_ALLOWED_CHANNEL_IDS: '111111111111111111, 222222222222222222,111111111111111111',
      DISCORD_ALLOW_DIRECT_MESSAGES: 'true',
      DISCORD_ALLOWED_USER_IDS: '333333333333333333,333333333333333333',
    });

    expect(config.discord).toEqual({
      enabled: true,
      botToken: 'discord-token',
      applicationId: '123456789012345678',
      guildId: '987654321098765432',
      allowedChannelIds: [
        '111111111111111111',
        '222222222222222222',
      ],
      allowDirectMessages: true,
      allowedUserIds: ['333333333333333333'],
    });
  });

  it.each([
    ['缺少 bot token', {
      DISCORD_ENABLED: 'true',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_ALLOWED_CHANNEL_IDS: '111111111111111111',
    }],
    ['缺少 application ID', {
      DISCORD_ENABLED: 'true',
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_ALLOWED_CHANNEL_IDS: '111111111111111111',
    }],
    ['application ID 格式錯誤', {
      DISCORD_ENABLED: 'true',
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_APPLICATION_ID: 'not-a-snowflake',
      DISCORD_ALLOWED_CHANNEL_IDS: '111111111111111111',
    }],
    ['缺少 channel ID', {
      DISCORD_ENABLED: 'true',
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_APPLICATION_ID: '123456789012345678',
    }],
    ['啟用私訊但缺少 user ID', {
      DISCORD_ENABLED: 'true',
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_ALLOW_DIRECT_MESSAGES: 'true',
    }],
    ['channel ID 格式錯誤', {
      DISCORD_ENABLED: 'true',
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_ALLOWED_CHANNEL_IDS: 'not-a-channel',
    }],
    ['user ID 格式錯誤', {
      DISCORD_ENABLED: 'true',
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_ALLOW_DIRECT_MESSAGES: 'true',
      DISCORD_ALLOWED_USER_IDS: 'not-a-user',
    }],
  ])('Discord %s 時拒絕設定', async (_name, env) => {
    await expect(loadFixture('defaults.yml', env)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it.each([
    ['缺少 channels', withoutChannels()],
    ['channels 不是陣列', validSource('channels: streamer')],
    ['channels 是空陣列', validSource('channels: []')],
    ['頻道名稱包含非法字元', validSource('channels: [good, bad-name]')],
    ['頻道名稱超過 25 字元', validSource(`channels: [${'a'.repeat(26)}]`)],
    ['頻道不是字串', validSource('channels: [123]')],
  ])('%s 時拋出 ConfigValidationError', async (_name, source) => {
    await expect(loadSource(source)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it.each([
    ['check_interval_seconds 型別錯誤', 'check_interval_seconds: "60"'],
    ['check_interval_seconds 小於 30', 'check_interval_seconds: 29'],
    ['check_interval_seconds 不是整數', 'check_interval_seconds: 30.5'],
    ['max_concurrent_streams 型別錯誤', 'max_concurrent_streams: "2"'],
    ['max_concurrent_streams 小於 1', 'max_concurrent_streams: 0'],
    ['max_concurrent_streams 不是整數', 'max_concurrent_streams: 1.5'],
    ['headless 型別錯誤', 'headless: "true"'],
    ['storage_state_path 型別錯誤', 'storage_state_path: 123'],
    ['storage_state_path 為空', 'storage_state_path: ""'],
    ['log_level 型別錯誤', 'log_level: 1'],
    ['log_level 不在允許清單', 'log_level: verbose'],
  ])('%s 時拒絕設定', async (_name, replacement) => {
    await expect(
      loadSource(validSource(replacement)),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it.each([
    ['twitch_api', 'channels: [streamer]\ntwitch_api: invalid'],
    [
      'browser',
      `${validSource('channels: [streamer]')}browser: invalid`,
    ],
  ])('%s 不是物件時拒絕設定', async (_field, source) => {
    await expect(loadSource(source)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it.each([
    ['client_id 缺少', 'access_token: fixture-access-token'],
    ['client_id 型別錯誤', 'client_id: 123\n  access_token: fixture-token'],
    ['client_id 為空', 'client_id: ""\n  access_token: fixture-token'],
    ['access_token 缺少', 'client_id: fixture-client-id'],
    ['access_token 型別錯誤', 'client_id: fixture-client-id\n  access_token: 123'],
    ['access_token 為空', 'client_id: fixture-client-id\n  access_token: ""'],
  ])('twitch_api.%s 時拒絕設定', async (_name, twitchApiBody) => {
    await expect(
      loadSource(configWithTwitchApi(twitchApiBody)),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it.each([
    ['engine', 'engine: webkit'],
    ['navigation_timeout_ms', 'navigation_timeout_ms: 0'],
    ['navigation_timeout_ms 型別', 'navigation_timeout_ms: "30000"'],
    [
      'page_health_check_interval_seconds',
      'page_health_check_interval_seconds: 0',
    ],
    [
      'page_health_check_interval_seconds 型別',
      'page_health_check_interval_seconds: 1.5',
    ],
    ['reward_check_interval_seconds', 'reward_check_interval_seconds: -1'],
    [
      'reward_check_interval_seconds 型別',
      'reward_check_interval_seconds: false',
    ],
    [
      'page_refresh_interval_seconds 型別',
      'page_refresh_interval_seconds: false',
    ],
    ['restart_on_crash', 'restart_on_crash: "true"'],
    ['stream_quality', 'stream_quality: 720p'],
    [
      'enforce_stream_quality_seconds',
      'enforce_stream_quality_seconds: 0',
    ],
    ['viewport_width', 'viewport_width: 319'],
    ['viewport_height', 'viewport_height: 179'],
    ['mute_audio', 'mute_audio: "true"'],
    ['block_images', 'block_images: "true"'],
    ['block_fonts', 'block_fonts: "true"'],
    ['block_known_tracking', 'block_known_tracking: "true"'],
    ['disable_chat', 'disable_chat: "true"'],
    [
      'resource_telemetry_interval_seconds',
      'resource_telemetry_interval_seconds: 0',
    ],
  ])('browser.%s 無效時拒絕設定', async (_name, browserBody) => {
    await expect(
      loadSource(configWithBrowser(browserBody)),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('設定檔不存在時拋出 ConfigFileNotFoundError', async () => {
    const path = join(tmpdir(), 'config-does-not-exist.yml');

    await expect(
      new YamlConfigLoader().load(path, {}),
    ).rejects.toBeInstanceOf(ConfigFileNotFoundError);
    await expect(new YamlConfigLoader().load(path, {})).rejects.toMatchObject(
      { configPath: path },
    );
  });

  it('YAML 語法錯誤時拋出 ConfigParseError', async () => {
    await expect(loadFixture('parse-error.yml')).rejects.toBeInstanceOf(
      ConfigParseError,
    );
  });

  it.each([
    'channels:\n\t- channel',
    'channels: [channel,,other]',
    'channels:\n  - channel\nchannels:\n  - other',
  ])('拒絕格式錯誤的 YAML', async (source) => {
    await expect(loadSource(source)).rejects.toSatisfy((error: unknown) =>
      [ConfigParseError, ConfigValidationError].some(
        (ErrorType) => error instanceof ErrorType,
      ),
    );
  });

  it('拒絕形成循環物件的 YAML alias', async () => {
    await expect(
      loadSource(`
root: &root
  self: *root
channels: [streamer]
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
`),
    ).rejects.toBeInstanceOf(ConfigParseError);
  });

  it.each([
    ['check_interval_seconds', 'check_interval_seconds: 2147484'],
    [
      'browser.navigation_timeout_ms',
      'browser:\n  navigation_timeout_ms: 2147483648',
    ],
    [
      'browser.page_health_check_interval_seconds',
      'browser:\n  page_health_check_interval_seconds: 2147484',
    ],
    [
      'browser.reward_check_interval_seconds',
      'browser:\n  reward_check_interval_seconds: 2147484',
    ],
    [
      'browser.page_refresh_interval_seconds',
      'browser:\n  page_refresh_interval_seconds: 2147484',
    ],
  ])('%s 超過 Node timer 上限時拒絕設定', async (_field, replacement) => {
    await expect(
      loadSource(validSource(replacement)),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it.each([
    ['sequence', '- root_sequence'],
    ['scalar', 'root_scalar'],
    ['null', 'null'],
  ])('%s 根節點走 ConfigValidationError', async (_kind, source) => {
    await expect(loadSource(source)).rejects.toMatchObject({
      name: 'ConfigValidationError',
      field: 'root',
    });
  });

  it('任何 parse 或 validation error 都不包含 access token 原文', async () => {
    const secret = 'never-print-this-access-token';
    const validationPromise = loadSource(
      `channels: [channel]
check_interval_seconds: 1
twitch_api:
  client_id: fixture-client-id
  access_token: ${secret}
`,
      { TWITCH_ACCESS_TOKEN: secret },
    );
    const parsePromise = loadSource(
      `channels: [channel]
twitch_api:
  client_id: fixture-client-id
  access_token: "${secret}
`,
    );

    const [validationError, parseError] = await Promise.all([
      captureError(validationPromise),
      captureError(parsePromise),
    ]);

    expect(String(validationError)).not.toContain(secret);
    expect(String(parseError)).not.toContain(secret);
  });

  it('回傳物件、陣列與巢狀設定皆不可變', async () => {
    const config = await loadFixture('valid.yml');

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.channels)).toBe(true);
    expect(Object.isFrozen(config.twitchApi)).toBe(true);
    expect(Object.isFrozen(config.browser)).toBe(true);
    expect(Object.isFrozen(config.browser.recovery)).toBe(true);
    expect(
      Object.isFrozen(config.browser.recovery.pageCrashBackoffSeconds),
    ).toBe(true);
    expect(Object.isFrozen(config.browser.sessionStart)).toBe(true);
    expect(
      Object.isFrozen(config.browser.sessionStart.failureBackoffSeconds),
    ).toBe(true);
    expect(Object.isFrozen(config.telegram)).toBe(true);
    expect(Object.isFrozen(config.telegram.allowedChatIds)).toBe(true);
    expect(Object.isFrozen(config.discord)).toBe(true);
    expect(Object.isFrozen(config.discord.allowedChannelIds)).toBe(true);
    expect(Object.isFrozen(config.discord.allowedUserIds)).toBe(true);
    expect(() => {
      (config.channels as string[]).push('another_channel');
    }).toThrow(TypeError);
    expect(() => {
      (config.twitchApi as { accessToken: string }).accessToken = 'changed';
    }).toThrow(TypeError);
  });
});

async function loadFixture(
  name: string,
  env: NodeJS.ProcessEnv = {},
  logger?: ConfigLogger,
): Promise<AppConfig> {
  return new YamlConfigLoader(logger).load(fixturePath(name), env);
}

function fixturePath(name: string): string {
  return join(fixtureDirectory, name);
}

async function loadSource(
  source: string,
  env: NodeJS.ProcessEnv = {},
  logger?: ConfigLogger,
): Promise<AppConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'twitch-config-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'config.yml');
  await writeFile(path, source, 'utf8');
  return new YamlConfigLoader(logger).load(path, env);
}

function validSource(replacement: string): string {
  return `${replacement}
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
`;
}

function withoutChannels(): string {
  return `twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
`;
}

function configWithTwitchApi(body: string): string {
  return `channels: [streamer]
twitch_api:
  ${body}
`;
}

function configWithBrowser(body: string): string {
  return `channels: [streamer]
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
browser:
  ${body}
`;
}

function configWithChannels(channels: readonly string[]): string {
  return `channels: [${channels.join(', ')}]
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
`;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error('預期 promise 拋出錯誤');
  } catch (error: unknown) {
    return error;
  }
}
