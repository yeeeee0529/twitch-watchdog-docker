import type { Page, Request, Response } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { PlaywrightBrowserPageAdapter } from '../../src/browser/adapters/PlaywrightBrowserPageAdapter.js';
import type {
  BrowserConsoleDiagnostic,
  BrowserHttpResponseDiagnostic,
  BrowserRequestFailureDiagnostic,
} from '../../src/browser/types.js';

type AnyListener = (payload: never) => void;

class FakePage {
  private readonly listeners = new Map<string, Set<AnyListener>>();

  public on(event: string, listener: AnyListener): void {
    let bucket = this.listeners.get(event);
    if (bucket === undefined) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(listener);
  }

  public off(event: string, listener: AnyListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  public emit(event: string, payload: never): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(payload);
    }
  }

  public listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  public isClosed(): boolean {
    return false;
  }

  public close = vi.fn(async (): Promise<void> => undefined);
}

function createFakeRequest(overrides: Partial<{
  url: string;
  method: string;
  resourceType: string;
  postData: string | null;
  failureText: string | undefined;
}> = {}): Request {
  const postData = overrides.postData ?? null;
  return {
    url: () => overrides.url ?? 'https://example.com/request',
    method: () => overrides.method ?? 'GET',
    resourceType: () => overrides.resourceType ?? 'other',
    postData: () => postData,
    failure: () =>
      overrides.failureText === undefined
        ? null
        : { errorText: overrides.failureText },
  } as unknown as Request;
}

function createFakeResponse(overrides: Partial<{
  url: string;
  method: string;
  resourceType: string;
  status: number;
  statusText: string;
  postData: string | null;
}> = {}): Response {
  const request = createFakeRequest({
    url: overrides.url ?? 'https://example.com/request',
    method: overrides.method,
    resourceType: overrides.resourceType,
    postData: overrides.postData,
  });
  return {
    url: () => overrides.url ?? 'https://example.com/response',
    request: () => request,
    status: () => overrides.status ?? 200,
    statusText: () => overrides.statusText ?? 'OK',
  } as unknown as Response;
}

describe('PlaywrightBrowserPageAdapter diagnostics', () => {
  it('訂閱與取消訂閱 requestfailed', () => {
    const page = new FakePage();
    const adapter = new PlaywrightBrowserPageAdapter(
      page as unknown as Page,
    );
    const captured: BrowserRequestFailureDiagnostic[] = [];
    const unsubscribe = adapter.onRequestFailed((diagnostic) => {
      captured.push(diagnostic);
    });

    expect(page.listenerCount('requestfailed')).toBe(1);
    unsubscribe();
    expect(page.listenerCount('requestfailed')).toBe(0);
  });

  it('將 requestfailed 轉為消毒後的結構化診斷', () => {
    const page = new FakePage();
    const adapter = new PlaywrightBrowserPageAdapter(
      page as unknown as Page,
    );
    const captured: BrowserRequestFailureDiagnostic[] = [];
    adapter.onRequestFailed((diagnostic) => {
      captured.push(diagnostic);
    });

    page.emit(
      'requestfailed',
      createFakeRequest({
        url: 'https://static.twitchcdn.net/assets/main.js?token=secret',
        method: 'GET',
        resourceType: 'script',
        failureText: 'net::ERR_ABORTED',
      }) as never,
    );

    expect(captured).toEqual([
      {
        url: 'static.twitchcdn.net/assets/main.js',
        method: 'GET',
        resourceType: 'script',
        failureText: 'net::ERR_ABORTED',
      },
    ]);
  });

  it('requestfailed 抽出 GraphQL operationName 但不含 variables', () => {
    const page = new FakePage();
    const adapter = new PlaywrightBrowserPageAdapter(
      page as unknown as Page,
    );
    const captured: BrowserRequestFailureDiagnostic[] = [];
    adapter.onRequestFailed((diagnostic) => {
      captured.push(diagnostic);
    });

    page.emit(
      'requestfailed',
      createFakeRequest({
        url: 'https://gql.twitch.tv/gql',
        method: 'POST',
        resourceType: 'fetch',
        failureText: 'net::ERR_FAILED',
        postData: JSON.stringify({
          operationName: 'PlaybackAccessToken',
          variables: { login: 'private_channel' },
        }),
      }) as never,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.graphQlOperationNames).toEqual([
      'PlaybackAccessToken',
    ]);
    expect(JSON.stringify(captured)).not.toContain('private_channel');
    expect(JSON.stringify(captured)).not.toContain('variables');
  });

  it('GraphQL body 解析失敗不傳播例外', () => {
    const page = new FakePage();
    const adapter = new PlaywrightBrowserPageAdapter(
      page as unknown as Page,
    );
    const captured: BrowserRequestFailureDiagnostic[] = [];
    adapter.onRequestFailed((diagnostic) => {
      captured.push(diagnostic);
    });

    page.emit(
      'requestfailed',
      createFakeRequest({
        url: 'https://gql.twitch.tv/gql',
        method: 'POST',
        resourceType: 'fetch',
        postData: '{invalid-json',
      }) as never,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.graphQlOperationNames).toBeUndefined();
  });

  it('訂閱與取消訂閱 response', () => {
    const page = new FakePage();
    const adapter = new PlaywrightBrowserPageAdapter(
      page as unknown as Page,
    );
    const captured: BrowserHttpResponseDiagnostic[] = [];
    const unsubscribe = adapter.onResponse((diagnostic) => {
      captured.push(diagnostic);
    });

    expect(page.listenerCount('response')).toBe(1);
    unsubscribe();
    expect(page.listenerCount('response')).toBe(0);
  });

  it('將 response 轉為含 status 的結構化診斷', () => {
    const page = new FakePage();
    const adapter = new PlaywrightBrowserPageAdapter(
      page as unknown as Page,
    );
    const captured: BrowserHttpResponseDiagnostic[] = [];
    adapter.onResponse((diagnostic) => {
      captured.push(diagnostic);
    });

    page.emit(
      'response',
      createFakeResponse({
        url: 'https://static.twitchcdn.net/assets/loader.js?x=1',
        method: 'GET',
        resourceType: 'script',
        status: 503,
        statusText: 'Service Unavailable',
      }) as never,
    );

    expect(captured).toEqual([
      {
        url: 'static.twitchcdn.net/assets/loader.js',
        method: 'GET',
        resourceType: 'script',
        status: 503,
        statusText: 'Service Unavailable',
      },
    ]);
  });

  it('訂閱與取消訂閱 console', () => {
    const page = new FakePage();
    const adapter = new PlaywrightBrowserPageAdapter(
      page as unknown as Page,
    );
    const captured: BrowserConsoleDiagnostic[] = [];
    const unsubscribe = adapter.onConsole((diagnostic) => {
      captured.push(diagnostic);
    });

    expect(page.listenerCount('console')).toBe(1);
    unsubscribe();
    expect(page.listenerCount('console')).toBe(0);
  });

  it('將 console message 轉為消毒後的結構化診斷', () => {
    const page = new FakePage();
    const adapter = new PlaywrightBrowserPageAdapter(
      page as unknown as Page,
    );
    const captured: BrowserConsoleDiagnostic[] = [];
    adapter.onConsole((diagnostic) => {
      captured.push(diagnostic);
    });

    page.emit(
      'console',
      {
        type: () => 'error',
        text: () => 'Failed with token=Bearer abc123',
        location: () => ({
          url: 'https://static.twitchcdn.net/app.js?secret=1',
          lineNumber: 12,
          columnNumber: 4,
        }),
      } as never,
    );

    expect(captured).toEqual([
      {
        type: 'error',
        text: 'Failed with token=[REDACTED] [REDACTED]',
        sourceUrl: 'static.twitchcdn.net/app.js',
        lineNumber: 12,
        columnNumber: 4,
      },
    ]);
  });

  it('console text 拋錯時吞掉例外且不呼叫 listener', () => {
    const page = new FakePage();
    const adapter = new PlaywrightBrowserPageAdapter(
      page as unknown as Page,
    );
    const listener = vi.fn();
    adapter.onConsole(listener);

    page.emit(
      'console',
      {
        type: () => 'error',
        text: () => {
          throw new Error('text serialization failed');
        },
        location: () => ({ url: '', lineNumber: 0, columnNumber: 0 }),
      } as never,
    );

    expect(listener).not.toHaveBeenCalled();
  });
});
