import type { RewardClaimResult } from '../browser/index.js';
import type { AppConfig } from '../config/index.js';
import { ConfigValidationError } from '../config/index.js';
import {
  redactSensitiveString,
  type Logger,
} from '../logging/index.js';
import type { BotCommandContext } from '../notifications/BotCommandContext.js';
import {
  formatBrowserRestartMessage,
  formatContainerRestartMessage,
  formatPageCrashMessage,
  type BrowserRestartNotification,
  type ContainerRestartNotification,
} from '../notifications/BotNotifications.js';
import type { StreamStatusChange } from '../scheduler/index.js';
import type {
  TelegramApi,
  TelegramBotCommand,
  TelegramReplyKeyboardMarkup,
  TelegramSendMessageOptions,
  TelegramUpdate,
} from './TelegramApiClient.js';
import { describeTelegramError } from './TelegramApiClient.js';

export interface TelegramBot {
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
  notifyStreamStatus(change: StreamStatusChange): Promise<void>;
  notifyReward(result: RewardClaimResult): Promise<void>;
  notifyPageCrash(channel: string): Promise<void>;
  notifyBrowserRestart(event: BrowserRestartNotification): Promise<void>;
  notifyContainerRestart(event: ContainerRestartNotification): Promise<void>;
}

export interface TelegramBotOptions {
  readonly config: AppConfig;
  readonly api: TelegramApi;
  readonly commandContext: BotCommandContext;
  readonly logger: Logger;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const QUERY_TIMEOUT_MS = 30_000;
const MAX_ACTIVE_QUERIES = 2;

const DEFAULT_SLEEP = async (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  await new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(handle);
        resolve();
      },
      { once: true },
    );
  });
};

export class DefaultTelegramBot implements TelegramBot {
  private readonly allowedChatIds: ReadonlySet<string>;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private abortController: AbortController | undefined;
  private pollingFlight: Promise<void> | undefined;
  private offset: number | undefined;
  private started = false;
  private readonly queryFlights = new Set<Promise<void>>();

  public constructor(private readonly options: TelegramBotOptions) {
    this.allowedChatIds = new Set(
      options.config.telegram.allowedChatIds,
    );
    this.sleep = options.sleep ?? DEFAULT_SLEEP;
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.abortController = new AbortController();
    try {
      await this.options.api.setMyCommands(BOT_COMMANDS);
    } catch (error: unknown) {
      this.options.logger.warn('telegram_command_menu_failed', {
        ...describeTelegramError(error),
        retryInMs: 0,
      });
    }
    await this.broadcast(this.formatServiceStarted(), {
      reply_markup: COMMAND_KEYBOARD,
    });
    this.pollingFlight = this.poll(this.abortController.signal);
  }

  public async stop(reason: string): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    const controller = this.abortController;
    const pollingFlight = this.pollingFlight;
    this.abortController = undefined;
    this.pollingFlight = undefined;

    controller?.abort();
    await pollingFlight;
    await this.broadcast(`Twitch Watchdog 已停止\n原因：${reason}`);
  }

  public notifyStreamStatus(change: StreamStatusChange): Promise<void> {
    return this.broadcast(
      change.isLive
        ? `🔴 ${change.channel} 已開台`
        : `⚫ ${change.channel} 已離線`,
    );
  }

  public notifyReward(result: RewardClaimResult): Promise<void> {
    if (result.status === 'claimed') {
      return this.broadcast(`🎁 ${result.channel} 已領取忠誠點數`);
    }
    if (result.status === 'click_failed') {
      return this.broadcast(`⚠️ ${result.channel} 忠誠點數領取失敗`);
    }
    return Promise.resolve();
  }

  public notifyPageCrash(channel: string): Promise<void> {
    return this.broadcast(formatPageCrashMessage(channel));
  }

  public notifyBrowserRestart(
    event: BrowserRestartNotification,
  ): Promise<void> {
    return this.broadcast(formatBrowserRestartMessage(event));
  }

  public notifyContainerRestart(
    event: ContainerRestartNotification,
  ): Promise<void> {
    return this.broadcast(formatContainerRestartMessage(event));
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failureCount = 0;

    while (!signal.aborted) {
      try {
        const updates = await this.options.api.getUpdates(
          this.offset,
          this.options.config.telegram.pollingTimeoutSeconds,
          signal,
        );
        failureCount = 0;
        for (const update of updates) {
          this.offset = Math.max(
            this.offset ?? 0,
            update.update_id + 1,
          );
          try {
            await this.handleUpdate(update);
          } catch (error: unknown) {
            this.options.logger.warn('telegram_command_failed', {
              updateId: update.update_id,
              ...describeTelegramError(error),
              retryInMs: 0,
            });
          }
        }
      } catch (error: unknown) {
        if (signal.aborted) {
          return;
        }
        failureCount += 1;
        const retryInMs = Math.min(
          30_000,
          1_000 * 2 ** (failureCount - 1),
        );
        this.options.logger.warn('telegram_poll_failed', {
          ...describeTelegramError(error),
          retryInMs,
        });
        await this.sleep(retryInMs, signal);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (message?.text === undefined) {
      return;
    }

    const chatId = String(message.chat.id);
    if (!this.allowedChatIds.has(chatId)) {
      this.options.logger.warn('telegram_unauthorized_chat');
      return;
    }

    const parsed = parseCommand(message.text);
    if (parsed === undefined) {
      return;
    }

    await this.handleCommand(chatId, parsed.command, parsed.argument);
  }

  private async handleCommand(
    chatId: string,
    command: string,
    argument: string | undefined,
  ): Promise<void> {
    switch (command) {
      case 'start':
      case 'help':
        await this.options.api.sendMessage(chatId, HELP_TEXT, {
          reply_markup: COMMAND_KEYBOARD,
        });
        return;
      case 'status':
        await this.options.api.sendMessage(chatId, this.formatStatus());
        return;
      case 'channels':
        await this.options.api.sendMessage(
          chatId,
          this.formatChannels(),
        );
        return;
      case 'refresh':
        await this.options.api.sendMessage(
          chatId,
          this.formatRefreshCountdown(),
        );
        return;
      case 'refresh_now':
        await this.refreshPages(chatId, argument);
        return;
      case 'points':
        await this.startQuery(chatId, command, (signal) =>
          this.sendChannelPoints(chatId, argument, signal));
        return;
      case 'config':
        await this.options.api.sendMessage(
          chatId,
          this.formatRuntimeConfig(),
        );
        return;
      case 'channel_add':
        await this.runConfigCommand(
          chatId,
          () => this.addChannel(chatId, argument),
        );
        return;
      case 'channel_remove':
        await this.runConfigCommand(
          chatId,
          () => this.removeChannel(chatId, argument),
        );
        return;
      case 'channels_set':
        await this.runConfigCommand(
          chatId,
          () => this.setChannels(chatId, argument),
        );
        return;
      case 'max_streams':
        await this.runConfigCommand(
          chatId,
          () => this.setMaxStreams(chatId, argument),
        );
        return;
      case 'check':
        await this.options.commandContext.runCheck();
        await this.options.api.sendMessage(chatId, '已完成一次狀態檢查。');
        return;
      case 'pause':
        await this.options.commandContext.pauseChecks();
        await this.options.api.sendMessage(chatId, '自動檢查已暫停。');
        return;
      case 'resume':
        this.options.commandContext.resumeChecks();
        await this.options.api.sendMessage(chatId, '自動檢查已恢復。');
        return;
      case 'screenshot':
        await this.startQuery(chatId, command, (signal) =>
          this.sendScreenshot(chatId, argument, signal));
        return;
      default:
        await this.options.api.sendMessage(
          chatId,
          `不支援的指令：/${command}\n\n${HELP_TEXT}`,
        );
    }
  }

  private async startQuery(
    chatId: string,
    command: string,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const shutdownSignal = this.abortController?.signal;
    if (shutdownSignal === undefined || shutdownSignal.aborted) {
      return;
    }
    if (this.queryFlights.size >= MAX_ACTIVE_QUERIES) {
      await this.options.api.sendMessage(
        chatId,
        '查詢仍在處理中，請稍後再試；可用 /status 查看服務狀態。',
      );
      return;
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([shutdownSignal, controller.signal]);
    const timeoutHandle = setTimeout(() => {
      controller.abort();
      this.options.logger.warn('telegram_query_timeout', { command });
      void this.options.api.sendMessage(
        chatId,
        `/${command} 處理逾時，請稍後再試；可用 /status 查看服務狀態。`,
      ).catch((error: unknown) => {
        this.options.logger.warn('telegram_send_failed', {
          ...describeTelegramError(error),
          retryInMs: 0,
        });
      });
    }, QUERY_TIMEOUT_MS);
    const cancelTimeout = (): void => clearTimeout(timeoutHandle);
    shutdownSignal.addEventListener('abort', cancelTimeout, { once: true });

    // 底層頁面工作結束前保留名額，避免逾時後重試造成無限排隊。
    const flight = operation(signal).catch(async (error: unknown) => {
      if (signal.aborted) {
        return;
      }
      this.options.logger.warn('telegram_query_failed', {
        command,
        ...describeTelegramError(error),
      });
      await this.options.api.sendMessage(
        chatId,
        `/${command} 處理失敗，請稍後再試。`,
      );
    }).catch((error: unknown) => {
      this.options.logger.warn('telegram_send_failed', {
        ...describeTelegramError(error),
        retryInMs: 0,
      });
    }).finally(() => {
      cancelTimeout();
      shutdownSignal.removeEventListener('abort', cancelTimeout);
      this.queryFlights.delete(flight);
    });
    this.queryFlights.add(flight);
  }

  private async sendScreenshot(
    chatId: string,
    requestedChannel: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (requestedChannel === undefined) {
      const activeChannels = this.options.commandContext.getActiveChannels();
      if (activeChannels.length === 0) {
        await this.options.api.sendMessage(
          chatId,
          '目前沒有正在觀看的頻道可供截圖。',
        );
        return;
      }

      let sentCount = 0;
      for (const channel of activeChannels) {
        signal.throwIfAborted();
        const screenshot = await this.captureScreenshotSafely(channel);
        signal.throwIfAborted();
        if (screenshot === undefined) {
          continue;
        }
        await this.sendSessionScreenshot(chatId, screenshot);
        sentCount += 1;
      }

      if (sentCount === 0) {
        await this.options.api.sendMessage(
          chatId,
          '目前沒有正在觀看的頻道可供截圖。',
        );
      }
      return;
    }

    const screenshot = await this.captureScreenshotSafely(requestedChannel);
    signal.throwIfAborted();
    if (screenshot === undefined) {
      const activeChannels = this.options.commandContext.getActiveChannels();
      const requestedIsActive = activeChannels.some(
        (channel) =>
          channel.toLocaleLowerCase('en-US') ===
          requestedChannel.toLocaleLowerCase('en-US'),
      );
      await this.options.api.sendMessage(
        chatId,
        activeChannels.length === 0
          ? '目前沒有正在觀看的頻道可供截圖。'
          : requestedIsActive
            ? `頻道目前無法截圖：${requestedChannel}`
            : [
                `找不到正在觀看的頻道：${requestedChannel ?? ''}`,
                `可用頻道：${activeChannels.join('、')}`,
              ].join('\n'),
      );
      return;
    }

    await this.sendSessionScreenshot(chatId, screenshot);
  }

  private async captureScreenshotSafely(
    channel: string,
  ): Promise<
    Awaited<ReturnType<BotCommandContext['captureScreenshot']>>
  > {
    try {
      return await this.options.commandContext.captureScreenshot(channel);
    } catch (error: unknown) {
      this.options.logger.warn('telegram_screenshot_failed', {
        channel,
        error: safeErrorMessage(error),
      });
      return undefined;
    }
  }

  private async refreshPages(
    chatId: string,
    requestedChannel: string | undefined,
  ): Promise<void> {
    const results =
      await this.options.commandContext.refreshPages(requestedChannel);
    if (results.length === 0) {
      const activeChannels = this.options.commandContext.getActiveChannels();
      await this.options.api.sendMessage(
        chatId,
        activeChannels.length === 0
          ? '目前沒有正在觀看的頻道可重整。'
          : [
              `找不到正在觀看的頻道：${requestedChannel ?? ''}`,
              `可用頻道：${activeChannels.join('、')}`,
            ].join('\n'),
      );
      return;
    }

    await this.options.api.sendMessage(
      chatId,
      [
        '手動重整結果：',
        ...results.map((result, index) => {
          if (result.status === 'refreshed') {
            return `${index + 1}. ${result.channel}：已重整`;
          }
          if (result.status === 'unavailable') {
            return `${index + 1}. ${result.channel}：目前無法重整`;
          }
          return `${index + 1}. ${result.channel}：重整失敗`;
        }),
      ].join('\n'),
    );
  }

  private async sendChannelPoints(
    chatId: string,
    requestedChannel: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const results =
      await this.options.commandContext.getChannelPoints(requestedChannel);
    signal.throwIfAborted();
    if (results.length === 0) {
      const activeChannels = this.options.commandContext.getActiveChannels();
      await this.options.api.sendMessage(
        chatId,
        activeChannels.length === 0
          ? '目前沒有正在觀看的頻道可查詢忠誠點數。'
          : [
              `找不到正在觀看的頻道：${requestedChannel ?? ''}`,
              `可用頻道：${activeChannels.join('、')}`,
            ].join('\n'),
      );
      return;
    }

    await this.options.api.sendMessage(
      chatId,
      [
        '忠誠點數：',
        ...results.map((result) =>
          result.status === 'available'
            ? `${result.channel}：${result.balance.toLocaleString('en-US')} 點`
            : `${result.channel}：無法取得`,
        ),
      ].join('\n'),
    );
  }

  private async sendSessionScreenshot(
    chatId: string,
    screenshot: {
      readonly channel: string;
      readonly image: Buffer;
    },
  ): Promise<void> {
    await this.options.api.sendPhoto(
      chatId,
      screenshot.image,
      `${screenshot.channel}.png`,
      `${screenshot.channel} 目前瀏覽器畫面`,
    );
    this.options.logger.info('telegram_screenshot_sent', {
      channel: screenshot.channel,
      bytes: screenshot.image.byteLength,
    });
  }

  private async addChannel(
    chatId: string,
    argument: string | undefined,
  ): Promise<void> {
    if (argument === undefined) {
      await this.options.api.sendMessage(
        chatId,
        '用法：/channel_add 頻道名稱',
      );
      return;
    }
    const current = this.options.commandContext.getConfig();
    if (
      current.channels.some(
        (channel) =>
          channel.toLocaleLowerCase('en-US') ===
          argument.toLocaleLowerCase('en-US'),
      )
    ) {
      await this.options.api.sendMessage(
        chatId,
        `頻道已在監控清單中：${argument}`,
      );
      return;
    }
    const updated = await this.options.commandContext.setChannels([
      ...current.channels,
      argument,
    ]);
    await this.options.api.sendMessage(
      chatId,
      `已加入頻道：${argument}\n${formatRuntimeConfig(updated)}`,
    );
  }

  private async runConfigCommand(
    chatId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error: unknown) {
      this.options.logger.warn('telegram_config_update_failed', {
        errorType:
          error instanceof Error ? error.name : 'UnknownError',
      });
      await this.options.api.sendMessage(
        chatId,
        error instanceof ConfigValidationError
          ? error.message
          : '設定更新失敗，請確認 config.yml 可寫入。',
      );
    }
  }

  private async removeChannel(
    chatId: string,
    argument: string | undefined,
  ): Promise<void> {
    if (argument === undefined) {
      await this.options.api.sendMessage(
        chatId,
        '用法：/channel_remove 頻道名稱',
      );
      return;
    }
    const current = this.options.commandContext.getConfig();
    const normalized = argument.toLocaleLowerCase('en-US');
    const channels = current.channels.filter(
      (channel) =>
        channel.toLocaleLowerCase('en-US') !== normalized,
    );
    if (channels.length === current.channels.length) {
      await this.options.api.sendMessage(
        chatId,
        `找不到監控頻道：${argument}`,
      );
      return;
    }
    const updated =
      await this.options.commandContext.setChannels(channels);
    await this.options.api.sendMessage(
      chatId,
      `已移除頻道：${argument}\n${formatRuntimeConfig(updated)}`,
    );
  }

  private async setChannels(
    chatId: string,
    argument: string | undefined,
  ): Promise<void> {
    const channels = parseChannelsArgument(argument);
    if (channels.length === 0) {
      await this.options.api.sendMessage(
        chatId,
        '用法：/channels_set 頻道一,頻道二',
      );
      return;
    }
    const updated =
      await this.options.commandContext.setChannels(channels);
    await this.options.api.sendMessage(
      chatId,
      `頻道清單已更新\n${formatRuntimeConfig(updated)}`,
    );
  }

  private async setMaxStreams(
    chatId: string,
    argument: string | undefined,
  ): Promise<void> {
    const value = Number(argument);
    if (
      argument === undefined ||
      !/^\d+$/u.test(argument) ||
      !Number.isSafeInteger(value)
    ) {
      await this.options.api.sendMessage(
        chatId,
        '用法：/max_streams 正整數',
      );
      return;
    }
    const updated =
      await this.options.commandContext.setMaxConcurrentStreams(value);
    await this.options.api.sendMessage(
      chatId,
      `最大同時觀看已更新為 ${value}\n${formatRuntimeConfig(updated)}`,
    );
  }

  private formatServiceStarted(): string {
    return [
      'Twitch Watchdog 已啟動',
      `監控頻道：${this.options.config.channels.length}`,
      `最大同時觀看：${this.options.config.maxConcurrentStreams}`,
    ].join('\n');
  }

  private formatStatus(): string {
    const snapshot = this.options.commandContext.getSchedulerSnapshot();
    const activeChannels = this.options.commandContext.getActiveChannels();
    const liveChannels = snapshot.channels
      .filter((channel) => channel.isLive === true)
      .map((channel) => channel.channel);

    return [
      `自動檢查：${snapshot.running ? '執行中' : '已暫停'}`,
      `檢查進行中：${snapshot.checkInFlight ? '是' : '否'}`,
      `上次完成：${snapshot.lastCheckedAt ?? '尚未完成'}`,
      `限流重試：${snapshot.retryAt ?? '無'}`,
      `目前開台：${formatList(liveChannels)}`,
      `正在觀看：${formatList(activeChannels)}`,
    ].join('\n');
  }

  private formatChannels(): string {
    const snapshot = this.options.commandContext.getSchedulerSnapshot();
    return snapshot.channels
      .map((status, index) => {
        const marker = status.isLive === true
          ? '🔴'
          : status.isLive === false
            ? '⚫'
            : '❔';
        return `${index + 1}. ${marker} ${status.channel}`;
      })
      .join('\n');
  }

  private formatRefreshCountdown(): string {
    const statuses = this.options.commandContext.getRefreshStatuses();
    if (statuses.length === 0) {
      return '目前沒有正在觀看的頻道。';
    }

    return [
      '重整倒數：',
      ...statuses.map((status, index) => {
        if (!status.enabled) {
          return `${index + 1}. ${status.channel}：已關閉定時重整`;
        }
        if (
          status.nextRefreshAt === undefined ||
          status.secondsUntilRefresh === undefined
        ) {
          return `${index + 1}. ${status.channel}：重整排程準備中`;
        }
        return [
          `${index + 1}. ${status.channel}：`,
          `${formatDuration(status.secondsUntilRefresh)}後`,
          `（下次：${status.nextRefreshAt}）`,
        ].join('');
      }),
    ].join('\n');
  }

  private formatRuntimeConfig(): string {
    return formatRuntimeConfig(
      this.options.commandContext.getConfig(),
    );
  }

  private async broadcast(
    text: string,
    options?: TelegramSendMessageOptions,
  ): Promise<void> {
    for (const chatId of this.allowedChatIds) {
      try {
        await this.options.api.sendMessage(chatId, text, options);
      } catch (error: unknown) {
        this.options.logger.warn('telegram_send_failed', {
          ...describeTelegramError(error),
          retryInMs: 0,
        });
      }
    }
  }
}

const HELP_TEXT = [
  '可用指令：',
  '/status - 顯示服務與觀看狀態',
  '/channels - 顯示監控頻道',
  '/refresh - 顯示 Twitch 播放器重整倒數',
  '/refresh_now [頻道] - 立即重整全部或指定觀看頁',
  '/points [頻道] - 顯示全部或指定頻道忠誠點數',
  '/config - 顯示可調整的設定',
  '/channel_add 頻道 - 新增監控頻道',
  '/channel_remove 頻道 - 移除監控頻道',
  '/channels_set 頻道一,頻道二 - 取代頻道清單',
  '/max_streams 數量 - 設定最大同時觀看',
  '/check - 立即檢查一次',
  '/pause - 暫停自動檢查',
  '/resume - 恢復自動檢查',
  '/screenshot [頻道] - 回傳全部或指定頻道畫面',
  '/help - 顯示說明',
].join('\n');

const BOT_COMMANDS: readonly TelegramBotCommand[] = Object.freeze([
  { command: 'status', description: '顯示服務與觀看狀態' },
  { command: 'channels', description: '顯示監控頻道' },
  { command: 'refresh', description: '顯示播放器重整倒數' },
  { command: 'refresh_now', description: '立即重整觀看頁' },
  { command: 'points', description: '顯示忠誠點數' },
  { command: 'config', description: '顯示頻道與同時觀看設定' },
  { command: 'channel_add', description: '新增監控頻道' },
  { command: 'channel_remove', description: '移除監控頻道' },
  { command: 'channels_set', description: '取代監控頻道清單' },
  { command: 'max_streams', description: '設定最大同時觀看' },
  { command: 'check', description: '立即檢查一次' },
  { command: 'pause', description: '暫停自動檢查' },
  { command: 'resume', description: '恢復自動檢查' },
  { command: 'screenshot', description: '擷取目前觀看畫面' },
  { command: 'help', description: '顯示指令說明' },
]);

const COMMAND_KEYBOARD: TelegramReplyKeyboardMarkup = Object.freeze({
  keyboard: [
    [{ text: '/status' }, { text: '/channels' }],
    [{ text: '/refresh' }, { text: '/refresh_now' }],
    [{ text: '/points' }],
    [{ text: '/config' }],
    [{ text: '/check' }, { text: '/screenshot' }],
    [{ text: '/pause' }, { text: '/resume' }],
    [{ text: '/help' }],
  ],
  is_persistent: true,
  resize_keyboard: true,
});

interface ParsedCommand {
  readonly command: string;
  readonly argument?: string;
}

function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  const separatorIndex = trimmed.search(/\s/u);
  const firstToken =
    separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  const argument =
    separatorIndex === -1
      ? undefined
      : trimmed.slice(separatorIndex).trim() || undefined;
  if (firstToken === undefined || !firstToken.startsWith('/')) {
    return undefined;
  }
  const command = firstToken
    .slice(1)
    .split('@', 1)[0]
    ?.toLocaleLowerCase('en-US');
  if (command === undefined || command === '') {
    return undefined;
  }
  return {
    command,
    ...(argument === undefined ? {} : { argument }),
  };
}

function safeErrorMessage(error: unknown): string {
  let message = 'Unknown Telegram command failure';

  try {
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error !== undefined && error !== null) {
      message = String(error);
    }
  } catch {
    message = 'Unserializable Telegram command failure';
  }

  return redactSensitiveString(message);
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? '無' : values.join('、');
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds} 秒`;
  }
  if (remainingSeconds === 0) {
    return `${minutes} 分鐘`;
  }
  return `${minutes} 分 ${remainingSeconds} 秒`;
}

function parseChannelsArgument(argument: string | undefined): string[] {
  return argument === undefined
    ? []
    : argument.split(/[\s,]+/u).filter((channel) => channel !== '');
}

function formatRuntimeConfig(config: {
  readonly channels: readonly string[];
  readonly maxConcurrentStreams: number;
}): string {
  return [
    `監控頻道：${config.channels.join('、')}`,
    `最大同時觀看：${config.maxConcurrentStreams}`,
  ].join('\n');
}
