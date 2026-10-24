export interface TelegramMessage {
  readonly message_id: number;
  readonly text?: string;
  readonly chat: {
    readonly id: number | string;
  };
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

export interface TelegramReplyKeyboardMarkup {
  readonly keyboard: readonly (readonly {
    readonly text: string;
  }[])[];
  readonly is_persistent?: boolean;
  readonly resize_keyboard?: boolean;
}

export interface TelegramSendMessageOptions {
  readonly reply_markup?: TelegramReplyKeyboardMarkup;
}

export interface TelegramApi {
  getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<readonly TelegramUpdate[]>;
  setMyCommands(commands: readonly TelegramBotCommand[]): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    options?: TelegramSendMessageOptions,
  ): Promise<void>;
  sendPhoto(
    chatId: string,
    image: Buffer,
    filename: string,
    caption: string,
  ): Promise<void>;
}

export interface TelegramApiClientOptions {
  readonly botToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface TelegramResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
}

const SEND_TIMEOUT_MS = 10_000;

export type TelegramErrorCategory =
  | 'aborted'
  | 'http'
  | 'invalid_response'
  | 'network'
  | 'timeout'
  | 'unknown';

export interface TelegramErrorDescriptor {
  readonly errorClass: string;
  readonly httpStatus: number | null;
  readonly errorCategory: TelegramErrorCategory;
}

export interface TelegramApiErrorOptions {
  readonly errorCategory?: TelegramErrorCategory;
  readonly httpStatus?: number;
}

export class TelegramApiError extends Error {
  public readonly errorCategory: TelegramErrorCategory;
  public readonly httpStatus: number | undefined;

  public constructor(
    public readonly method: string,
    message = 'Telegram API request failed',
    options: TelegramApiErrorOptions = {},
  ) {
    super(message);
    this.name = 'TelegramApiError';
    this.errorCategory = options.errorCategory ?? 'unknown';
    this.httpStatus = options.httpStatus;
  }
}

export function describeTelegramError(
  error: unknown,
): TelegramErrorDescriptor {
  if (error instanceof TelegramApiError) {
    return {
      errorClass: error.name,
      httpStatus: error.httpStatus ?? null,
      errorCategory: error.errorCategory,
    };
  }

  if (error instanceof Error) {
    return {
      errorClass: safeErrorClass(error),
      httpStatus: null,
      errorCategory:
        error.name === 'TimeoutError'
          ? 'timeout'
          : error.name === 'AbortError'
            ? 'aborted'
            : 'unknown',
    };
  }

  return {
    errorClass: 'UnknownError',
    httpStatus: null,
    errorCategory: 'unknown',
  };
}

function safeErrorClass(error: Error): string {
  let className = 'Error';
  try {
    const prototype = Object.getPrototypeOf(error) as {
      readonly constructor?: unknown;
    } | null;
    if (typeof prototype?.constructor === 'function') {
      className = prototype.constructor.name;
    }
  } catch {
    return 'Error';
  }
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(className)
    ? className
    : 'Error';
}

export class TelegramApiClient implements TelegramApi {
  private readonly fetch: typeof globalThis.fetch;

  public constructor(private readonly options: TelegramApiClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  public async getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<readonly TelegramUpdate[]> {
    return this.call<readonly TelegramUpdate[]>(
      'getUpdates',
      {
        ...(offset === undefined ? {} : { offset }),
        timeout: timeoutSeconds,
        allowed_updates: ['message'],
      },
      AbortSignal.any([
        signal,
        AbortSignal.timeout(timeoutSeconds * 1_000 + SEND_TIMEOUT_MS),
      ]),
    );
  }

  public async setMyCommands(
    commands: readonly TelegramBotCommand[],
  ): Promise<void> {
    await this.call<unknown>(
      'setMyCommands',
      { commands },
      AbortSignal.timeout(SEND_TIMEOUT_MS),
    );
  }

  public async sendMessage(
    chatId: string,
    text: string,
    options: TelegramSendMessageOptions = {},
  ): Promise<void> {
    await this.call<unknown>('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4_096),
      ...options,
    }, AbortSignal.timeout(SEND_TIMEOUT_MS));
  }

  public async sendPhoto(
    chatId: string,
    image: Buffer,
    filename: string,
    caption: string,
  ): Promise<void> {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('caption', caption.slice(0, 1_024));
    form.set(
      'photo',
      new Blob([new Uint8Array(image)], { type: 'image/png' }),
      filename,
    );
    await this.callForm<unknown>(
      'sendPhoto',
      form,
      AbortSignal.timeout(SEND_TIMEOUT_MS),
    );
  }

  private async call<T>(
    method: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;

    try {
      response = await this.fetch(
        `https://api.telegram.org/bot${this.options.botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch {
      if (signal?.aborted === true) {
        throw createAbortError(method, signal);
      }
      throw new TelegramApiError(
        method,
        'Telegram network request failed',
        { errorCategory: 'network' },
      );
    }

    let payload: TelegramResponse<T>;
    try {
      payload = await response.json() as TelegramResponse<T>;
    } catch {
      if (signal?.aborted === true) {
        throw createAbortError(method, signal);
      }
      throw new TelegramApiError(
        method,
        'Telegram returned invalid JSON',
        {
          errorCategory: 'invalid_response',
          httpStatus: response.status,
        },
      );
    }

    if (!response.ok || payload.ok !== true || payload.result === undefined) {
      throw new TelegramApiError(
        method,
        payload.description === undefined
          ? `Telegram API returned HTTP ${response.status}`
          : `Telegram API rejected ${method}`,
        { errorCategory: 'http', httpStatus: response.status },
      );
    }

    return payload.result;
  }

  private async callForm<T>(
    method: string,
    body: FormData,
    signal: AbortSignal,
  ): Promise<T> {
    let response: Response;

    try {
      response = await this.fetch(
        `https://api.telegram.org/bot${this.options.botToken}/${method}`,
        {
          method: 'POST',
          body,
          redirect: 'error',
          signal,
        },
      );
    } catch {
      if (signal.aborted) {
        throw createAbortError(method, signal);
      }
      throw new TelegramApiError(
        method,
        'Telegram network request failed',
        { errorCategory: 'network' },
      );
    }

    return parseTelegramResponse<T>(response, method);
  }
}

async function parseTelegramResponse<T>(
  response: Response,
  method: string,
): Promise<T> {
  let payload: TelegramResponse<T>;
  try {
    payload = await response.json() as TelegramResponse<T>;
  } catch {
    throw new TelegramApiError(
      method,
      'Telegram returned invalid JSON',
      {
        errorCategory: 'invalid_response',
        httpStatus: response.status,
      },
    );
  }

  if (!response.ok || payload.ok !== true || payload.result === undefined) {
    throw new TelegramApiError(
      method,
      payload.description === undefined
        ? `Telegram API returned HTTP ${response.status}`
        : `Telegram API rejected ${method}`,
      { errorCategory: 'http', httpStatus: response.status },
    );
  }

  return payload.result;
}

function createAbortError(
  method: string,
  signal: AbortSignal,
): TelegramApiError {
  const timedOut =
    signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  return new TelegramApiError(
    method,
    timedOut ? 'Telegram request timed out' : 'Telegram request aborted',
    { errorCategory: timedOut ? 'timeout' : 'aborted' },
  );
}
