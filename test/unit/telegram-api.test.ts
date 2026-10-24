import { describe, expect, it, vi } from 'vitest';

import {
  TelegramApiClient,
  TelegramApiError,
} from '../../src/telegram/index.js';

describe('TelegramApiClient', () => {
  it('以 POST JSON 呼叫 getUpdates、setMyCommands 與 sendMessage', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: [{ update_id: 7 }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { message_id: 9 },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { message_id: 10 },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: true,
      })));
    const client = new TelegramApiClient({
      botToken: 'test-bot-token',
      fetch: fetchMock,
    });
    const controller = new AbortController();

    await expect(
      client.getUpdates(5, 25, controller.signal),
    ).resolves.toEqual([{ update_id: 7 }]);
    await client.setMyCommands([
      { command: 'status', description: '顯示狀態' },
    ]);
    await client.sendMessage('-100123', 'hello', {
      reply_markup: {
        keyboard: [[{ text: '/status' }]],
        resize_keyboard: true,
      },
    });
    await client.sendPhoto(
      '-100123',
      Buffer.from('png-image'),
      'channel.png',
      'channel screenshot',
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.telegram.org/bottest-bot-token/getUpdates',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({
          offset: 5,
          timeout: 25,
          allowed_updates: ['message'],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.telegram.org/bottest-bot-token/setMyCommands',
      expect.objectContaining({
        body: JSON.stringify({
          commands: [
            { command: 'status', description: '顯示狀態' },
          ],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.telegram.org/bottest-bot-token/sendMessage',
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: '-100123',
          text: 'hello',
          reply_markup: {
            keyboard: [[{ text: '/status' }]],
            resize_keyboard: true,
          },
        }),
      }),
    );
    const fourthCall = fetchMock.mock.calls[3];
    expect(fourthCall?.[0]).toBe(
      'https://api.telegram.org/bottest-bot-token/sendPhoto',
    );
    expect(fourthCall?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      redirect: 'error',
    }));
    const form = fourthCall?.[1]?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) {
      throw new Error('預期 sendPhoto 使用 FormData');
    }
    expect(form.get('chat_id')).toBe('-100123');
    expect(form.get('caption')).toBe('channel screenshot');
    const photo = form.get('photo');
    expect(photo).toBeInstanceOf(Blob);
    expect((photo as File).name).toBe('channel.png');
    expect((photo as Blob).type).toBe('image/png');
  });

  it.each(['request', 'body'])('getUpdates 的 %s 卡住時會逾時，後續可重試', async (stage) => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
      const signal = options?.signal;
      const hang = () => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      if (stage === 'request') {
        return hang();
      }
      return { ok: true, status: 200, json: hang } as unknown as Response;
    });
    const client = new TelegramApiClient({ botToken: 'test-token', fetch: fetchMock });
    try {
      const result = captureError(client.getUpdates(undefined, 25, new AbortController().signal));
      await Promise.resolve();
      expect(timeoutSpy).toHaveBeenCalledWith(35_000);
      timeoutController.abort(new DOMException('Timed out', 'TimeoutError'));
      await expect(result).resolves.toMatchObject({ errorCategory: 'timeout' });
      timeoutSpy.mockRestore();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: [] })));
      await expect(client.getUpdates(undefined, 25, new AbortController().signal)).resolves.toEqual([]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('停止訊號會取消 getUpdates', async () => {
    const controller = new AbortController();
    const client = new TelegramApiClient({
      botToken: 'test-token',
      fetch: vi.fn<typeof fetch>(async (_url, options) => new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
    });
    const result = captureError(client.getUpdates(undefined, 25, controller.signal));
    controller.abort();
    await expect(result).resolves.toMatchObject({ errorCategory: 'aborted' });
  });

  it('網路錯誤不包含 bot token 或完整 URL', async () => {
    const secret = '123456:telegram-secret';
    const client = new TelegramApiClient({
      botToken: secret,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(
        new Error(`failed https://api.telegram.org/bot${secret}`),
      ),
    });

    const error = await captureError(client.sendMessage('1', 'hello'));

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain('api.telegram.org');
    expect(error).toMatchObject({
      errorCategory: 'network',
      httpStatus: undefined,
    });
  });

  it('API 拒絕時不轉送 Telegram description 內容', async () => {
    const client = new TelegramApiClient({
      botToken: 'safe-test-token',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            description: 'secret remote details',
          }),
          { status: 401 },
        ),
      ),
    });

    const error = await captureError(client.sendMessage('1', 'hello'));

    expect(String(error)).toContain('Telegram API rejected sendMessage');
    expect(String(error)).not.toContain('secret remote details');
    expect(error).toMatchObject({
      errorCategory: 'http',
      httpStatus: 401,
    });
  });

  it('無效 JSON 保留安全的 HTTP status 與錯誤分類', async () => {
    const client = new TelegramApiClient({
      botToken: 'safe-test-token',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('not-json', { status: 502 }),
      ),
    });

    const error = await captureError(client.sendMessage('1', 'hello'));

    expect(error).toMatchObject({
      errorCategory: 'invalid_response',
      httpStatus: 502,
    });
  });
});

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error('預期 promise 失敗');
  } catch (error: unknown) {
    return error;
  }
}
