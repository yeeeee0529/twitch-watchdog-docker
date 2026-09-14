import { expect, test } from '@playwright/test';

import { PlaywrightBrowserPageAdapter } from '../../src/browser/adapters/PlaywrightBrowserPageAdapter.js';
import {
  DefaultBrowserManager,
  type BrowserAdapter,
  type BrowserContextAdapter,
  type BrowserLauncher,
  type BrowserManagerLogger,
  type BrowserPageAdapter,
} from '../../src/browser/BrowserManager.js';
import type {
  BrowserConsoleDiagnostic,
  BrowserHttpResponseDiagnostic,
  BrowserRequestFailureDiagnostic,
} from '../../src/browser/types.js';
import { createTestConfig } from '../helpers/test-config.js';

test('page adapter 將失敗請求、非成功回應與 console 轉為消毒後的診斷', async ({ page }) => {
  await page.route(/blocked\.js/, (route) => route.abort('failed'));
  await page.route(/failing-api/, (route) =>
    route.fulfill({ status: 500, statusText: 'Boom' }));

  const adapter = new PlaywrightBrowserPageAdapter(page);
  const requestFailures: BrowserRequestFailureDiagnostic[] = [];
  const responses: BrowserHttpResponseDiagnostic[] = [];
  const consoleMessages: BrowserConsoleDiagnostic[] = [];
  adapter.onRequestFailed((diagnostic) => {
    requestFailures.push(diagnostic);
  });
  adapter.onResponse((diagnostic) => {
    responses.push(diagnostic);
  });
  adapter.onConsole((diagnostic) => {
    consoleMessages.push(diagnostic);
  });

  await page.evaluate(() => {
    console.error('Twitch bootstrap error token=abc123');
    const script = document.createElement('script');
    script.src = 'https://diagnostics.example/blocked.js?token=secret';
    document.head.appendChild(script);
    void fetch('https://diagnostics.example/failing-api?client_id=hidden').catch(
      () => undefined,
    );
  });

  await expect.poll(() => requestFailures.length).toBeGreaterThan(0);
  await expect.poll(() => responses.length).toBeGreaterThan(0);
  await expect.poll(() => consoleMessages.length).toBeGreaterThan(0);

  const blockedFailure = requestFailures.find(
    (item) => item.url === 'diagnostics.example/blocked.js',
  );
  expect(blockedFailure).toMatchObject({
    url: 'diagnostics.example/blocked.js',
    method: 'GET',
    resourceType: 'script',
  });
  expect(responses[0]).toMatchObject({
    url: 'diagnostics.example/failing-api',
    method: 'GET',
    resourceType: 'fetch',
    status: 500,
  });
  expect(consoleMessages[0]).toMatchObject({
    type: 'error',
  });
  const serialized = JSON.stringify({
    requestFailures,
    responses,
    consoleMessages,
  });
  expect(serialized).not.toContain('token=secret');
  expect(serialized).not.toContain('client_id=hidden');
  expect(serialized).not.toContain('abc123');
});

test('BrowserManager 以 channel 與 generation 記錄消毒後的診斷', async ({ page }) => {
  await page.route(/blocked\.js/, (route) => route.abort('failed'));
  await page.route(/failing-api/, (route) =>
    route.fulfill({ status: 500, statusText: 'Boom' }));

  const logs: Array<{
    event: string;
    fields: Readonly<Record<string, unknown>>;
  }> = [];
  const logger: BrowserManagerLogger = {
    debug: (event, fields = {}) => logs.push({ event, fields }),
    info: (event, fields = {}) => logs.push({ event, fields }),
    warn: (event, fields = {}) => logs.push({ event, fields }),
    error: (event, fields = {}) => logs.push({ event, fields }),
  };

  const launcher: BrowserLauncher = {
    async launch(): Promise<BrowserAdapter> {
      const context: BrowserContextAdapter = {
        async configureResourceBlocking(): Promise<void> {},
        async configureChatBlocking(): Promise<void> {},
        async newPage(): Promise<BrowserPageAdapter> {
          return new PlaywrightBrowserPageAdapter(page);
        },
        async close(): Promise<void> {},
      };
      return {
        async newContext() {
          return context;
        },
        async close(): Promise<void> {},
        onDisconnected(): () => void {
          return () => undefined;
        },
        isConnected(): boolean {
          return true;
        },
        getVersion(): string {
          return 'e2e-diagnostics';
        },
      };
    },
  };

  const manager = new DefaultBrowserManager(
    createTestConfig({ channels: ['diag_channel'] }),
    { launcher, logger },
  );
  await manager.start();
  await manager.createPage('diag_channel');

  await page.evaluate(() => {
    console.error('Twitch bootstrap error token=abc123');
    const script = document.createElement('script');
    script.src = 'https://diagnostics.example/blocked.js?token=secret';
    document.head.appendChild(script);
    void fetch('https://diagnostics.example/failing-api?client_id=hidden').catch(
      () => undefined,
    );
  });

  await expect
    .poll(() => logs.filter((item) => item.event === 'browser_request_failed').length)
    .toBeGreaterThan(0);
  await expect
    .poll(() => logs.filter((item) => item.event === 'browser_http_response').length)
    .toBeGreaterThan(0);
  await expect
    .poll(() => logs.filter((item) => item.event === 'browser_console_message').length)
    .toBeGreaterThan(0);

  const requestFailed = logs.find(
    (item) =>
      item.event === 'browser_request_failed' &&
      item.fields.path === '/blocked.js',
  );
  expect(requestFailed?.fields).toMatchObject({
    channel: 'diag_channel',
    browserGeneration: 1,
    pageGeneration: 1,
    host: 'diagnostics.example',
    path: '/blocked.js',
    method: 'GET',
    resourceType: 'script',
  });

  const httpResponse = logs.find(
    (item) => item.event === 'browser_http_response',
  );
  expect(httpResponse?.fields).toMatchObject({
    channel: 'diag_channel',
    host: 'diagnostics.example',
    path: '/failing-api',
    httpStatus: 500,
  });

  const consoleMessage = logs.find(
    (item) => item.event === 'browser_console_message',
  );
  expect(consoleMessage?.fields).toMatchObject({
    channel: 'diag_channel',
    consoleType: 'error',
  });

  const serialized = JSON.stringify(logs);
  expect(serialized).not.toContain('token=secret');
  expect(serialized).not.toContain('client_id=hidden');
  expect(serialized).not.toContain('abc123');
});
